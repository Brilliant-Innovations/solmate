variable "profile" {
  type    = string
  default = "P4"
}

variable "region" {
  description = "DigitalOcean region near the Supabase project (blueprint §5.2: choose geography near the active runtime profile)."
  type        = string
  default     = "nyc3"
}

variable "vpc_ip_range" {
  type    = string
  default = "10.42.0.0/24"
}

variable "ssh_key_ids" {
  type = list(string)
}

variable "operator_cidrs" {
  description = "Operator machine addresses allowed to SSH and to reach the executor out-of-band endpoint. Never 0.0.0.0/0."
  type        = list(string)
  validation {
    condition     = length(var.operator_cidrs) > 0 && !contains(var.operator_cidrs, "0.0.0.0/0")
    error_message = "operator_cidrs must list the operator's addresses; the out-of-band endpoint is never open to the internet."
  }
}

variable "image_tag" {
  description = "Reviewed image tag (sha-<full sha>) whose bundles passed the artifact scan and report the locked contract digest."
  type        = string
}

variable "worker_size" {
  type    = string
  default = "s-2vcpu-4gb"
}

variable "isolated_size" {
  description = "Size for risk-authorizer and execution-service; both are small, single-purpose processes."
  type        = string
  default     = "s-1vcpu-2gb"
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
