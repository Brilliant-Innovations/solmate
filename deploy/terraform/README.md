# Terraform for the persistent profiles (P3, P4)

Written in M11, applied only at profile promotion (M12) with operator sign-off — ADR-0002. Nothing here is required for Profile 0/1 paper trading, and running `apply` creates paid DigitalOcean resources.

| Root | Profile | Topology |
| --- | --- | --- |
| `profile-3/` | P3 unattended live pilot | one Droplet (`vm-1`) running worker, risk-authorizer and execution-service as three hardened containers with three separate volumes and three separate env files; one VPC; one firewall |
| `profile-4/` | P4 hardened `LIVE_AUTO` | three Droplets (`do-worker`, `do-risk-authorizer`, `do-execution-service`), one VPC, one firewall per host, one Block Storage volume per service |
| `modules/solmate-host/` | shared | Droplet + volumes + cloud-init that installs Docker and one systemd unit per service |

## What the manifests prove (P0 acceptance, blueprint §28)

- **Three distinct Droplets** (P4): each financial service has its own host, size and tags.
- **VPC / firewall boundaries**: default-deny firewalls; SSH and the executor's out-of-band endpoint only from `operator_cidrs`; the risk-authorizer and executor internal APIs only from the worker Droplet by id; outbound limited to 443, 53 and NTP. Hostname-level egress (Supabase, Sentry, Birdeye, Helius, Jupiter, Turnkey, Jito) is enforced at the application layer and by the runtime egress test in CI, because DigitalOcean firewalls filter by address, not name.
- **Separate service secrets**: Terraform carries no secret. Each unit reads `/etc/solmate/<service>.env` (mode 0600, root) that the operator places after `apply`; the unit refuses to start without it (`ConditionPathExists`). Listener addresses come from the Droplet metadata service, never from the env file.
- **Service-specific attached persistence**: one `digitalocean_volume` per service mounted at `/var/lib/solmate/<service>` and passed to the container as `/journal` (`EXECUTOR_JOURNAL_PATH`, `AUDIT_CHECKPOINT_PATH`, `SHADOW_JOURNAL_PATH`). Volumes outlive Droplets; the infrastructure-loss runbook re-attaches them to replacement hosts.
- **Same containers as Profile 0**: the GHCR images built by `.github/workflows/images.yml`, run read-only with all capabilities dropped and no new privileges, exactly like `deploy/profile-0/docker-compose.yml`.

## Operating it

```sh
export DIGITALOCEAN_TOKEN=…            # operator shell only
cd deploy/terraform/profile-4
cp terraform.tfvars.example terraform.tfvars   # gitignored
terraform init -backend-config=backend.hcl     # state outside the repository (Spaces bucket with versioning)
terraform plan
terraform apply                                # promotion step; needs the M12 evidence first
terraform output worker_env_hints out_of_band_url env_files_expected
```

Then, per host: `scp` the service env file to `/etc/solmate/<service>.env` (root, 0600), and `systemctl start solmate-<service>`. The worker's env file takes `RISK_AUTHORIZER_URL` and `EXECUTION_SERVICE_URL` from `worker_env_hints`; the operator's `traderctl` env file takes `OUT_OF_BAND_URL` from `out_of_band_url`. Every service still validates its whole credential set and refuses a credential outside its trust class before it runs (`libs/contracts/src/config/env.ts`).

Image tags: pin `sha-<full sha>` of a commit whose CI run passed the artifact scan, the transitive policy and the standalone digest check; `image_tag` is deliberately not defaulted.

## Not done here

- No Terraform binary is part of the workspace toolchain; `terraform validate` runs on the operator's machine at promotion time (recorded in the promotion evidence).
- No DNS, no load balancer, no public ingress of any kind for the financial services; the web app stays on Vercel and talks only to Supabase.
- No secret, token, address of the cold-recovery wallet or signer credential appears in any file under this directory or in the state.
