output "droplet_id" {
  value = digitalocean_droplet.this.id
}

output "public_ip" {
  value = digitalocean_droplet.this.ipv4_address
}

output "private_ip" {
  description = "VPC address the service listeners bind to; the worker's EXECUTION_SERVICE_URL / RISK_AUTHORIZER_URL point here."
  value       = digitalocean_droplet.this.ipv4_address_private
}

output "volumes" {
  value = { for k, v in digitalocean_volume.journal : k => { id = v.id, name = v.name } }
}

output "env_files_expected" {
  description = "Files the operator places before the units start (mode 0600, owner root); none is created by Terraform."
  value       = [for s in var.services : "/etc/solmate/${s.name}.env"]
}
