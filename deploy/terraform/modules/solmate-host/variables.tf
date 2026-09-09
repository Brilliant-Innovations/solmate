variable "name" {
  description = "Droplet name (do-worker, do-risk-authorizer, do-execution-service, or vm-1 for Profile 3)."
  type        = string
}

variable "profile" {
  description = "Deployment profile this host serves (P3 or P4)."
  type        = string
  validation {
    condition     = contains(["P3", "P4"], var.profile)
    error_message = "Terraform hosts exist only for the persistent profiles P3 and P4 (ADR-0002)."
  }
}

variable "region" {
  type = string
}

variable "size" {
  description = "Fixed-price Droplet size (blueprint §5.2: Basic Droplets are the reference)."
  type        = string
  default     = "s-1vcpu-2gb"
}

variable "image" {
  type    = string
  default = "ubuntu-24-04-x64"
}

variable "vpc_id" {
  type = string
}

variable "ssh_key_ids" {
  description = "DigitalOcean SSH key ids allowed to reach the operator user. Password login is disabled."
  type        = list(string)
}

variable "tags" {
  type    = list(string)
  default = []
}

variable "volume_size_gb" {
  description = "Block Storage size per service volume; the executor journal is small and append-only."
  type        = number
  default     = 10
}

variable "registry" {
  type    = string
  default = "ghcr.io/brilliant-innovations"
}

variable "image_tag" {
  description = "Image tag published by .github/workflows/images.yml (sha-<full sha> or v<tag>). Pin a sha for a reviewed deployment."
  type        = string
}

variable "operator_user" {
  type    = string
  default = "solmate"
}

variable "services" {
  description = <<-EOT
    Services this host runs. `listen` entries are the env variables that must bind to the private VPC
    address (INTERNAL_API_LISTEN, OUT_OF_BAND_LISTEN) with their ports; `journal_env` names the env
    variable that receives the volume mount path inside the container (/journal).
  EOT
  type = list(object({
    name        = string
    listen      = map(number)
    journal_env = string
    extra_env   = optional(map(string), {})
  }))
}
