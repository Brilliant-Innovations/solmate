# One DigitalOcean Droplet running one or more Solmate services from the GHCR images, each with
# its own Block Storage volume for the durable journal / shadow / audit checkpoints (blueprint
# §5.2 Profile 3/4, D22/D23 durability, P0 acceptance "service-specific attached persistence";
# ADR-0002: written in M11, applied only at profile promotion).
#
# No secret enters Terraform: each service reads /etc/solmate/<service>.env, which the operator
# places on the host after `apply` (mode 0600, root). The systemd unit refuses to start without it.
# Internal listeners bind to the Droplet's private VPC address only; the executor's out-of-band
# endpoint is reachable solely from the operator CIDRs the root module allows in its firewall.

terraform {
  required_providers {
    digitalocean = {
      source  = "digitalocean/digitalocean"
      version = "~> 2.40"
    }
  }
}

locals {
  volume_name = { for s in var.services : s.name => "${var.name}-${s.name}-journal" }
}

resource "digitalocean_volume" "journal" {
  for_each                = { for s in var.services : s.name => s }
  region                  = var.region
  name                    = local.volume_name[each.key]
  size                    = var.volume_size_gb
  initial_filesystem_type = "ext4"
  description             = "Solmate ${each.key} durable journal / shadow / checkpoints (${var.profile})"
  tags                    = concat(var.tags, ["solmate", var.profile, "service:${each.key}"])
}

resource "digitalocean_droplet" "this" {
  name       = var.name
  region     = var.region
  size       = var.size
  image      = var.image
  vpc_uuid   = var.vpc_id
  ssh_keys   = var.ssh_key_ids
  monitoring = true
  ipv6       = false
  backups    = false
  tags       = concat(var.tags, ["solmate", var.profile, "host:${var.name}"])
  volume_ids = [for v in digitalocean_volume.journal : v.id]

  user_data = templatefile("${path.module}/cloud-init.yaml.tftpl", {
    hostname   = var.name
    profile    = var.profile
    image_tag  = var.image_tag
    registry   = var.registry
    services   = var.services
    volumes    = local.volume_name
    operator   = var.operator_user
  })

  lifecycle {
    # Replacing a host must be a deliberate operator action (runbook: infrastructure loss); volumes
    # outlive the Droplet and are re-attached to its replacement.
    prevent_destroy = false
    ignore_changes  = [user_data]
  }
}
