# Terraform for the persistent profiles (P3, P4)

Written in M11, applied only at profile promotion (M12) with operator sign-off — ADR-0002. Nothing here is required for Profile 0/1 paper trading, and running `apply` creates paid DigitalOcean resources.

| Root | Profile | Topology |
| --- | --- | --- |
| `profile-3/` | P3 unattended live pilot | one Droplet (`vm-1`) running worker, risk-authorizer and execution-service as three hardened containers with three separate volumes and three separate env files; one VPC; one firewall |
| `profile-4/` | P4 hardened `LIVE_AUTO` | three Droplets (`do-worker`, `do-risk-authorizer`, `do-execution-service`), one VPC, one firewall per host, one Block Storage volume per service |
| `modules/solmate-host/` | shared | Droplet + volumes + cloud-init that installs Docker and one systemd unit per service |

## What the manifests prove (P0 acceptance, blueprint §28)

- **Three distinct Droplets** (P4): each financial service has its own host, size and tags.
- **Inter-host firewall boundaries**: default-deny firewalls; SSH from `operator_cidrs` only; the risk-authorizer and executor internal APIs admitted from the worker Droplet by id and from nowhere else; the executor's out-of-band emergency port from `operator_cidrs` only; outbound limited to 443, 53 and NTP, with the worker additionally permitted to reach the two internal API ports on its siblings.
- **Separate service secrets**: Terraform carries no secret. Each unit reads `/etc/solmate/<service>.env` (mode 0600, root) that the operator places after `apply`; the unit refuses to start without it (`ConditionPathExists`). Listener addresses come from the Droplet metadata service, never from the env file.
- **Service-specific attached persistence**: one `digitalocean_volume` per service mounted at `/var/lib/solmate/<service>` and passed to the container as `/journal` (`EXECUTOR_JOURNAL_PATH`, `AUDIT_CHECKPOINT_PATH`, `SHADOW_JOURNAL_PATH`). Volumes outlive Droplets and re-attach to a replacement; units declare `RequiresMountsFor` so systemd resolves and escapes the mount unit name itself.
- **Same containers as Profile 0**: the GHCR images built by `.github/workflows/images.yml`, run read-only with all capabilities dropped and no new privileges, exactly like `deploy/profile-0/docker-compose.yml`.

## What the manifests do **not** prove

Recorded here rather than left implied — the adversarial review of 2026-09-09 found each of these stated too strongly in an earlier revision.

- **The container is not a network boundary.** Every unit runs `--network host`. On Profile 4 the three services are on three hosts, so the firewall is the boundary. On **Profile 3 all three trust levels share one network namespace**: a compromised worker — the deployable that by design ingests untrusted provider text and runs LLM calls — has unmediated TCP reach to the risk-authorizer's internal API, to the executor's out-of-band plane and to the Droplet metadata service. `INTERNAL_API_SECRET` is the boundary there, which is a credential boundary, not a network one. That is the single-host blast radius Profile 3 explicitly accepts (blueprint §5.2); it is not something the manifests remove.
- **Egress is filtered by address, not by hostname.** The application-layer allowlist (Supabase, Sentry, Birdeye, Helius, Jupiter, Turnkey, Jito) is enforced by the runtime egress test in CI. `https_egress_cidrs` / `dns_egress_cidrs` default to the whole internet; narrow them to provider ranges or an egress proxy before Profile 4 carries meaningful capital.
- **Images are pulled by a mutable tag.** The unit runs `docker pull …:${image_tag}`, not a `@sha256:` digest, and the readiness binding records `imageDigest: null` (`apps/worker/src/main.ts`). Anyone who can push to GHCR can re-point a reviewed tag, and no readiness evidence is invalidated by the swap. Pinning the digest end to end is an open item.
- **No Terraform binary runs in CI.** `terraform fmt`/`validate`/`plan` happen on the operator's machine at promotion and are recorded in the promotion evidence. CI does run `node tools/check-cloud-init.mjs`, which renders the cloud-init template for both profiles' service shapes and checks the generated shell with `sh -n`/`bash -n` and the generated units for their mount and hardening directives — that lint exists because two defects that would have bricked a promotion lived in template output nothing had ever parsed.

## Operating it

```sh
export DIGITALOCEAN_TOKEN=…            # operator shell only
cd deploy/terraform/profile-4
cp terraform.tfvars.example terraform.tfvars   # gitignored
terraform init -backend-config=backend.hcl     # state outside the repository (Spaces bucket with versioning)
terraform fmt -check && terraform validate
terraform plan
terraform apply                                # promotion step; needs the M12 evidence first
terraform output worker_env_hints out_of_band_url env_files_expected
```

Then, per host: `scp` the service env file to `/etc/solmate/<service>.env` (root, 0600), and `systemctl start solmate-<service>`. The worker's env file takes `RISK_AUTHORIZER_URL` and `EXECUTION_SERVICE_URL` from `worker_env_hints`; the operator's `traderctl` env file takes `OUT_OF_BAND_URL` from `out_of_band_url`. Every service still validates its whole credential set and refuses a credential outside its trust class before it runs (`libs/contracts/src/config/env.ts`).

## Deploying a new image

`image_tag` is interpolated into the systemd units inside `user_data`, and `user_data` is ForceNew in the DigitalOcean provider, so **bumping the tag replaces the Droplet**. That is deliberate — immutable hosts, with the journal and checkpoint volumes surviving as separate resources and re-attaching to the replacement. The alternative (`ignore_changes = [user_data]`) makes a tag bump a silent no-op and was removed for exactly that reason.

Replacing a host that holds live exposure is not a routine deploy. Order:

1. `PAUSE_NEW_ENTRIES` (web, or `node tools/traderctl.mjs <operator-env> pause`).
2. Reach zero exposure, or prove every remaining lot is `OFFLINE_PROTECTED` within policy (§21.2B) — the same bar `END SESSION` applies.
3. `terraform plan` and confirm the replacement is the only change.
4. `terraform apply`; the volume detaches from the old Droplet and re-attaches to the new one.
5. Place the env files again (they are not on the volume), start the units, let reconciliation and journal-import run.
6. Re-run Live Readiness and resume with step-up.

For an urgent patch without replacement: `ssh` to the host, `docker pull <registry>/solmate-<service>:<tag> && systemctl restart solmate-<service>`. That leaves Terraform state describing a different tag than the host runs, so follow it with the tag bump and replacement at the next opportunity.

Pin `sha-<full sha>` of a commit whose CI run passed the artifact scan, the transitive policy and the standalone digest check; `image_tag` is deliberately not defaulted.

## Not done here

- No DNS, no load balancer, no public ingress for the financial services beyond the out-of-band emergency port; the web app stays on Vercel and talks only to Supabase.
- No secret, token, cold-recovery address or signer credential appears in any file under this directory or in the state.
