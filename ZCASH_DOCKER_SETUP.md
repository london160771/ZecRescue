# Windows setup notes: Zallet + Zebra Docker mainnet

**Status: PREPARED / NOT YET PROVEN.** These steps have not been run in this workspace. They are for the later Phase 0 live receiver/shielding proof, not evidence that Zcash recovery currently works. Do not send meaningful ZEC during the first run.

## Requirements and current support

- Use Docker Desktop for Windows with the WSL 2 Linux engine and an Ubuntu WSL distribution. Run the Z3 checkout and shell scripts from Ubuntu/WSL, not native Windows PowerShell.
- Current upstream Z3 Docker workflow packages Zebra and Zallet together. Its published quick start requires Docker Compose v2.24.4 or later.
- Plan for at least 300 GB free SSD storage (500 GB recommended), 8 GB RAM minimum (16 GB recommended), and a long initial sync. Upstream estimates mainnet Zebra sync at 24–72 hours.
- Zallet is currently beta and its wallet setup is documented as unstable/manual. Read the release notes and current Zallet Book before creating the only copy of a real wallet.

## Install and start the mainnet node

1. Install/update WSL2 and Docker Desktop. In Docker Desktop, enable the WSL2 engine and Ubuntu integration. Open Ubuntu and verify `docker version` and `docker compose version`; require Compose 2.24.4+.
2. In Ubuntu/WSL:

   ```bash
   sudo apt-get update
   sudo apt-get install -y git
   git clone https://github.com/ZcashFoundation/z3.git
   cd z3
   git status --short
   ```

3. Keep Zallet and Zebra RPC ports on host loopback. Before running Compose, in that same shell:

   ```bash
   export Z3_ZEBRA_HOST_RPC_PORT=127.0.0.1:8232
   export Z3_ZEBRA_HOST_HEALTH_PORT=127.0.0.1:8080
   export Z3_ZALLET_HOST_RPC_PORT=127.0.0.1:28232
   ```

   These override the host-side published ports; Zallet's cookie authentication remains enabled. Do not disable authentication or expose the plaintext wallet RPC on a LAN/public interface. Confirm the resolved port bindings before using the wallet.

4. Run the upstream one-time mainnet setup, then start Zebra alone and wait for a full sync:

   ```bash
   ./scripts/setup-network.sh mainnet
   docker compose --env-file .env.mainnet up -d zebra
   ./scripts/check-zebra-readiness.sh
   ```

   The readiness check can take many hours and exits only when Zebra is near tip. Do not start Zallet against an unsynced chain for the live receiver proof.

5. After Zebra is ready, start the rest of the mainnet stack and inspect its status:

   ```bash
   docker compose --env-file .env.mainnet up -d
   docker compose --env-file .env.mainnet ps
   docker compose --env-file .env.mainnet logs --tail 100 zebra zallet
   ```

   Query wallet status through the in-container CLI (the RPC cookie stays inside the wallet data volume):

   ```bash
   docker compose --env-file .env.mainnet exec zallet \
     /usr/local/bin/zallet-zaino --datadir /var/lib/zallet \
     --config /etc/zallet/zallet.toml rpc getwalletstatus
   ```

   Stop without deleting data with `docker compose --env-file .env.mainnet --profile "*" down`. Do not use `down -v` unless intentionally wiping the wallet and the multi-hundred-GB chain data.

## Create a fresh user-controlled wallet

1. Follow the current [Zallet wallet setup guide](https://zcash.github.io/zallet/guide/setup.html) for the exact CLI flow shipped by the pinned Docker image. Initialize wallet encryption, generate exactly one fresh mnemonic, and back it up offline before deriving accounts. Never paste or upload the phrase. Do not run `generate-mnemonic` repeatedly: each invocation creates another independent root of spend authority.
2. The current documented CLI sequence uses `generate-encryption-identity`, `init-wallet-encryption`, then `generate-mnemonic`. Z3's one-time setup creates the local config and encryption identity; check the current release notes to avoid generating a second identity or seed unnecessarily. Run commands inside the Zallet container, for example:

   ```bash
   docker compose --env-file .env.mainnet exec zallet \
     /usr/local/bin/zallet-zaino --datadir /var/lib/zallet \
     --config /etc/zallet/zallet.toml init-wallet-encryption
   docker compose --env-file .env.mainnet exec -it zallet \
     /usr/local/bin/zallet-zaino --datadir /var/lib/zallet \
     --config /etc/zallet/zallet.toml generate-mnemonic
   ```

   The mnemonic is secret terminal output: do not screen-share, capture a screenshot, paste it, or leave it in shell history. Back it up offline. Run the release's documented `confirm-backup` step if required before deriving addresses. Do not copy the cookie, wallet database, mnemonic, or keys to the hosted app/backend.
3. Use `zallet rpc help z_getnewaccount` and `zallet rpc help z_getaddressforaccount` inside the container to confirm the pinned image's live parameter shape. Call `z_getnewaccount` for the recovery account. Call `z_getaddressforaccount` three times using the same account and the current default receiver set; because the default includes a transparent receiver, current docs say each call advances to a fresh diversifier index. Check every result with `z_listunifiedreceivers`; label the three distinct paths Base, Arbitrum, and Optimism only in the user's local environment.
4. Do not assume the provider can pay a shielded address. The Phase 0 report currently has no live NEAR ZEC payout or local shield proof. If the validated route pays transparent ZEC, test that boundary with a tiny amount and clearly treat the public transparent receive as linkable.

## Planned live receive and shielding verification

After the node and fresh account are ready, the separate Phase 0 live test should:

1. Send a tiny mainnet ZEC amount to a fresh Recovery Vault transparent receiver controlled by the user. Confirm Zallet sees it in that account using current `z_listtransactions` and `z_getbalanceforaccount` RPCs.
2. For ordinary transparent incoming funds (not mining coinbase), the documented account-send shape is `z_sendfromaccount(account, fund_source, recipients, minconf, privacy_policy)`. If needed, inspect the current RPC help first. Use the one transparent address as the fund source and a shielded recipient; the method accepts an array of specific transparent source addresses. Do not paste secret parameters into command history.
3. Review the required privacy policy and transaction outputs before signing. Transparent inputs publicly reveal the source and amount; the relevant policy may be `AllowRevealedSenders`. Use an Orchard receiver only after verifying the current network activation and current Zallet's returned receiver set.
4. Confirm the mined transaction and confirm the value appears in the account's Orchard/Ironwood balance. Record transaction IDs and amounts, never secret keys.

`z_shieldcoinbase` is for coinbase UTXOs; do not treat it as the ordinary transparent deposit sweep. For ordinary transparent funds the current documented entry point is `z_sendfromaccount` or the supported `z_sendmany` path, subject to the privacy policy Zallet reports.

## Local RPC boundary

Zallet's own JSON-RPC is plaintext HTTP with wallet-level authority. Keep host publication bound to `127.0.0.1`, retain cookie authentication, and make the future `zecrescue-agent` the only local caller. Do not publish the agent or Zallet RPC to the Internet. The eventual local agent should keep all Zcash keys in the local Zallet data path and send only required receiving addresses/status back to the browser/backend.

## Official references

- [Z3 mainnet quick start and resource requirements](https://github.com/ZcashFoundation/z3#quick-start)
- [Z3 Docker architecture](https://github.com/ZcashFoundation/z3/blob/main/docs/docker-architecture.md)
- [Zallet Docker guide](https://zcash.github.io/zallet/guide/installation/docker.html)
- [Zallet wallet setup](https://zcash.github.io/zallet/guide/setup.html)
- [Zallet RPC method reference](https://zcash.github.io/zallet/rpc/index.html)
- [Zallet operating and RPC security](https://zcash.github.io/zallet/operations/index.html)
