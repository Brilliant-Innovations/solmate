# Profile 3 — unattended live pilot on one persistent fixed-price VM (config/profiles/P3.json;
# blueprint §5.2 "a single small VM is sufficient for early live pilots when the operator
# explicitly accepts the single-host blast radius and the attested capital ceiling is small").
# Written in M11 per ADR-0002; applied only at promotion. The three financial services keep
# separate credential files and separate volumes on the one host; internal listeners bind to the
# private VPC address so nothing but this host reaches them; the executor is split onto its own
# Droplet (profile-4 layout) when capital warrants.

terraform {
  required_version = ">= 1.6"
  required_providers {
    digitalocean = {
      source  = "digitalocean/digitalocean"
      version = "~> 2.40"
    }
  }
  backend "s3" {}
}

provider "digitalocean" {}

resource "digitalocean_vpc" "solmate" {
  name     = "solmate-p3-${var.region}"
  region   = var.region
  ip_range = var.vpc_ip_range
}

module "vm" {
  source      = "../modules/solmate-host"
  name        = "vm-1"
  profile     = "P3"
  region      = var.region
  size        = var.size
  vpc_id      = digitalocean_vpc.solmate.id
  ssh_key_ids = var.ssh_key_ids
  image_tag   = var.image_tag
  tags        = ["trust:worker", "trust:risk-authorizer", "trust:execution-service"]
  services = [
    { name = "worker", listen = {}, journal_env = "AUDIT_CHECKPOINT_PATH", extra_env = { SHADOW_JOURNAL_PATH = "/journal/shadow.jsonl" } },
    { name = "risk-authorizer", listen = { INTERNAL_API_LISTEN = var.risk_authorizer_port }, journal_env = "AUDIT_CHECKPOINT_PATH" },
    { name = "execution-service", listen = { INTERNAL_API_LISTEN = var.execution_service_port, OUT_OF_BAND_LISTEN = var.out_of_band_port }, journal_env = "EXECUTOR_JOURNAL_PATH" },
  ]
}

resource "digitalocean_firewall" "vm" {
  name        = "solmate-p3-vm-1"
  droplet_ids = [module.vm.droplet_id]

  inbound_rule {
    protocol         = "tcp"
    port_range       = "22"
    source_addresses = var.operator_cidrs
  }
  # Internal APIs bind to the private address and are called from the same host; no inbound rule
  # admits them from anywhere. Only the out-of-band emergency endpoint is reachable, from operators.
  inbound_rule {
    protocol         = "tcp"
    port_range       = tostring(var.out_of_band_port)
    source_addresses = var.operator_cidrs
  }

  outbound_rule {
    protocol              = "tcp"
    port_range            = "443"
    destination_addresses = ["0.0.0.0/0"]
  }
  outbound_rule {
    protocol              = "tcp"
    port_range            = "53"
    destination_addresses = ["0.0.0.0/0"]
  }
  outbound_rule {
    protocol              = "udp"
    port_range            = "53"
    destination_addresses = ["0.0.0.0/0"]
  }
  outbound_rule {
    protocol              = "udp"
    port_range            = "123"
    destination_addresses = ["0.0.0.0/0"]
  }
}

variable "region" {
  type    = string
  default = "nyc3"
}

variable "vpc_ip_range" {
  type    = string
  default = "10.43.0.0/24"
}

variable "size" {
  type    = string
  default = "s-2vcpu-4gb"
}

variable "ssh_key_ids" {
  type = list(string)
}

variable "operator_cidrs" {
  type = list(string)
  validation {
    condition     = length(var.operator_cidrs) > 0 && !contains(var.operator_cidrs, "0.0.0.0/0")
    error_message = "operator_cidrs must list the operator's addresses; the out-of-band endpoint is never open to the internet."
  }
}

variable "image_tag" {
  type = string
}

variable "risk_authorizer_port" {
  type    = number
  default = 8781
}

variable "execution_service_port" {
  type    = number
  default = 8791
}

variable "out_of_band_port" {
  type    = number
  default = 8792
}

output "host" {
  value = { public = module.vm.public_ip, private = module.vm.private_ip, volumes = module.vm.volumes }
}

output "worker_env_hints" {
  value = {
    RISK_AUTHORIZER_URL   = "http://${module.vm.private_ip}:${var.risk_authorizer_port}"
    EXECUTION_SERVICE_URL = "http://${module.vm.private_ip}:${var.execution_service_port}"
    DEPLOYMENT_PROFILE    = "P3"
  }
}

output "out_of_band_url" {
  value = "http://${module.vm.public_ip}:${var.out_of_band_port}"
}
