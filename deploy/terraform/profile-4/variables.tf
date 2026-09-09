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

variable "https_egress_cidrs" {
  description = <<-EOT
    Outbound 443 destinations for every host. The default permits the whole internet, which leaves a
    compromised risk-authorizer or executor free to exfiltrate over TLS; narrow it to the provider
    ranges (Supabase, Sentry, the RPC endpoints, Turnkey) or to an egress proxy before Profile 4
    carries meaningful capital. Recorded as an open item in deploy/terraform/README.md.
  EOT
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "dns_egress_cidrs" {
  description = "Outbound 53 destinations. Narrow to the resolvers the hosts actually use (DigitalOcean's are 67.207.67.2/3) to close DNS as an exfiltration channel."
  type        = list(string)
  default     = ["0.0.0.0/0"]
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
