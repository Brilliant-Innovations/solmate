output "vpc_id" {
  value = digitalocean_vpc.solmate.id
}

output "hosts" {
  description = "Public and private addresses per host; the private addresses are what the worker env file names."
  value = {
    worker            = { public = module.worker.public_ip, private = module.worker.private_ip, volumes = module.worker.volumes }
    risk_authorizer   = { public = module.risk_authorizer.public_ip, private = module.risk_authorizer.private_ip, volumes = module.risk_authorizer.volumes }
    execution_service = { public = module.execution_service.public_ip, private = module.execution_service.private_ip, volumes = module.execution_service.volumes }
  }
}

output "worker_env_hints" {
  description = "Values the operator writes into /etc/solmate/worker.env on do-worker (no secret here)."
  value = {
    RISK_AUTHORIZER_URL   = "http://${module.risk_authorizer.private_ip}:${var.risk_authorizer_port}"
    EXECUTION_SERVICE_URL = "http://${module.execution_service.private_ip}:${var.execution_service_port}"
    DEPLOYMENT_PROFILE    = var.profile
  }
}

output "out_of_band_url" {
  description = "traderctl target (OUT_OF_BAND_URL in the operator env file), reachable from operator_cidrs only."
  value       = "http://${module.execution_service.public_ip}:${var.out_of_band_port}"
}

output "env_files_expected" {
  value = {
    "do-worker"            = module.worker.env_files_expected
    "do-risk-authorizer"   = module.risk_authorizer.env_files_expected
    "do-execution-service" = module.execution_service.env_files_expected
  }
}
