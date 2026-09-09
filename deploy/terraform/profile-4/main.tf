# Profile 4 — hardened autonomous LIVE_AUTO (config/profiles/P4.json; blueprint §5.2, D65, P0
# acceptance: "three distinct Droplets, VPC/firewall boundaries, separate service secrets and
# service-specific attached persistence for worker/risk-authorizer/execution-service").
# Written in M11 per ADR-0002; applied only at profile promotion (M12) with operator sign-off.
#
# Topology: one VPC; three Droplets, one per financial service, each with its own Block Storage
# volume; firewalls that admit SSH and the executor out-of-band endpoint from the operator CIDRs
# only, the internal APIs from the worker Droplet only, and outbound 443/53/123 only. The web app
# stays on Vercel (P4.json services.web.host = vercel) and never reaches these hosts.

terraform {
  required_version = ">= 1.6"
  required_providers {
    digitalocean = {
      source  = "digitalocean/digitalocean"
      version = "~> 2.40"
    }
  }
  # State holds host ids and addresses, never secrets. Keep it outside the repository, e.g. a
  # DigitalOcean Spaces bucket with versioning; configure with `terraform init -backend-config`.
  backend "s3" {}
}

provider "digitalocean" {
  # DIGITALOCEAN_TOKEN from the operator's shell; never in a file this repository tracks.
}

resource "digitalocean_vpc" "solmate" {
  name     = "solmate-${lower(var.profile)}-${var.region}"
  region   = var.region
  ip_range = var.vpc_ip_range
}

module "worker" {
  source      = "../modules/solmate-host"
  name        = "do-worker"
  profile     = var.profile
  region      = var.region
  size        = var.worker_size
  vpc_id      = digitalocean_vpc.solmate.id
  ssh_key_ids = var.ssh_key_ids
  image_tag   = var.image_tag
  tags        = ["trust:worker"]
  services = [{
    name        = "worker"
    listen      = {}
    journal_env = "AUDIT_CHECKPOINT_PATH"
    extra_env   = { SHADOW_JOURNAL_PATH = "/journal/shadow.jsonl" }
  }]
}

module "risk_authorizer" {
  source      = "../modules/solmate-host"
  name        = "do-risk-authorizer"
  profile     = var.profile
  region      = var.region
  size        = var.isolated_size
  vpc_id      = digitalocean_vpc.solmate.id
  ssh_key_ids = var.ssh_key_ids
  image_tag   = var.image_tag
  tags        = ["trust:risk-authorizer"]
  services = [{
    name        = "risk-authorizer"
    listen      = { INTERNAL_API_LISTEN = var.risk_authorizer_port }
    journal_env = "AUDIT_CHECKPOINT_PATH"
  }]
}

module "execution_service" {
  source      = "../modules/solmate-host"
  name        = "do-execution-service"
  profile     = var.profile
  region      = var.region
  size        = var.isolated_size
  vpc_id      = digitalocean_vpc.solmate.id
  ssh_key_ids = var.ssh_key_ids
  image_tag   = var.image_tag
  tags        = ["trust:execution-service"]
  services = [{
    name = "execution-service"
    listen = { INTERNAL_API_LISTEN = var.execution_service_port }
    # D25 plane 1: traderctl reaches this from an operator machine outside the VPC, so it cannot bind
    # the private address. The firewall admits it from operator_cidrs only.
    public_listen = { OUT_OF_BAND_LISTEN = var.out_of_band_port }
    journal_env   = "EXECUTOR_JOURNAL_PATH"
  }]
}

# --- firewalls: default deny; every rule below is the whole allowed surface -----------------------

# DigitalOcean firewalls filter by address, not hostname, so the application-layer egress allowlist
# (Supabase, Sentry, Birdeye, Helius, Jupiter, Turnkey, Jito) is enforced by the runtime egress test
# in CI, not here. `https_egress_cidrs` is the knob that narrows the network layer: leaving it at
# 0.0.0.0/0 means a post-build compromise of the risk-authorizer — the process that holds the
# risk-authorization private key and is meant to be the most isolated of the three — can reach any
# host on 443 (§32 "Can … arbitrary public egress appear inside the built risk-authorizer artifact").
# Pin it to provider ranges or an egress proxy before Profile 4 carries meaningful capital.
locals {
  egress = [
    { protocol = "tcp", port_range = "443", destination_addresses = var.https_egress_cidrs },
    { protocol = "tcp", port_range = "53", destination_addresses = var.dns_egress_cidrs },
    { protocol = "udp", port_range = "53", destination_addresses = var.dns_egress_cidrs },
    { protocol = "udp", port_range = "123", destination_addresses = ["0.0.0.0/0"] },
  ]
}

resource "digitalocean_firewall" "worker" {
  name        = "solmate-${lower(var.profile)}-worker"
  droplet_ids = [module.worker.droplet_id]

  inbound_rule {
    protocol         = "tcp"
    port_range       = "22"
    source_addresses = var.operator_cidrs
  }

  # A DigitalOcean firewall drops every outbound flow that no rule admits, so the worker's calls to
  # the two isolated services need explicit egress; without these, every risk authorization and every
  # execute times out and D52 fails entries closed — a total trading outage.
  outbound_rule {
    protocol                = "tcp"
    port_range              = tostring(var.risk_authorizer_port)
    destination_droplet_ids = [module.risk_authorizer.droplet_id]
  }
  outbound_rule {
    protocol                = "tcp"
    port_range              = tostring(var.execution_service_port)
    destination_droplet_ids = [module.execution_service.droplet_id]
  }

  dynamic "outbound_rule" {
    for_each = local.egress
    content {
      protocol              = outbound_rule.value.protocol
      port_range            = outbound_rule.value.port_range
      destination_addresses = outbound_rule.value.destination_addresses
    }
  }
}

resource "digitalocean_firewall" "risk_authorizer" {
  name        = "solmate-${lower(var.profile)}-risk-authorizer"
  droplet_ids = [module.risk_authorizer.droplet_id]

  inbound_rule {
    protocol         = "tcp"
    port_range       = "22"
    source_addresses = var.operator_cidrs
  }
  # Internal API: only the worker Droplet, inside the VPC. The browser and the executor never call it.
  inbound_rule {
    protocol           = "tcp"
    port_range         = tostring(var.risk_authorizer_port)
    source_droplet_ids = [module.worker.droplet_id]
  }

  dynamic "outbound_rule" {
    for_each = local.egress
    content {
      protocol              = outbound_rule.value.protocol
      port_range            = outbound_rule.value.port_range
      destination_addresses = outbound_rule.value.destination_addresses
    }
  }
}

resource "digitalocean_firewall" "execution_service" {
  name        = "solmate-${lower(var.profile)}-execution-service"
  droplet_ids = [module.execution_service.droplet_id]

  inbound_rule {
    protocol         = "tcp"
    port_range       = "22"
    source_addresses = var.operator_cidrs
  }
  # Internal API: worker only (execute, shadow, journal, emergency monitor path).
  inbound_rule {
    protocol           = "tcp"
    port_range         = tostring(var.execution_service_port)
    source_droplet_ids = [module.worker.droplet_id]
  }
  # Out-of-band emergency endpoint (D25 plane 1): operator machines only, never the worker or the web.
  inbound_rule {
    protocol         = "tcp"
    port_range       = tostring(var.out_of_band_port)
    source_addresses = var.operator_cidrs
  }

  dynamic "outbound_rule" {
    for_each = local.egress
    content {
      protocol              = outbound_rule.value.protocol
      port_range            = outbound_rule.value.port_range
      destination_addresses = outbound_rule.value.destination_addresses
    }
  }
}
