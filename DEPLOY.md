# Deploying Big Walk Radio

Three stages, in the order you'll want them:

1. [A working server on its IP](#1-a-working-server) — proves the files are in
   place and nginx serves them.
2. [radio.sevenstack.net, with TLS](#2-the-subdomain-and-tls) — the real thing.
3. [Deploying from GitHub](#3-deploying-from-github) — push to `main`, done.

The one thing to keep in mind throughout: **the build and the music travel
separately.** `dist/` is 55 KB and rebuilt on every deploy; `music/` is 148 MB,
is not in the repo, and is uploaded once by hand. They are kept in different
directories on the server so that a deploy can never delete the music.

---

## 1. A working server

### Creating the Linode

| Option | Choice | Why |
| --- | --- | --- |
| Image | **Ubuntu 24.04 LTS** | Supported to 2029; nginx and certbot are current in its repos. |
| Plan | **Nanode 1 GB** (Shared CPU, $5/mo) | 1 vCPU, 1 GB RAM, 25 GB disk, 1 TB transfer. nginx serving static files needs a fraction of this, and 148 MB of music leaves 24 GB spare. |
| Region | Nearest you | It sets your latency and can't be changed later without a migration. |
| SSH key | Paste your public key | Then you never need the root password. |
| Root password | Set one, store it | Only for the Lish console if you lock yourself out. |
| Backups | **Enable** (+$2/mo) | The music is the only thing here that isn't reproducible from git. |
| Private IP / VLAN | Off | Nothing else to talk to. |

Then add a **Cloud Firewall** (Linode's own, free — under Networking) and
attach it to the instance:

| Direction | Rule |
| --- | --- |
| Inbound | Accept TCP 22 (SSH) — narrow to your own IP if it's static |
| Inbound | Accept TCP 80, 443 |
| Inbound | Drop everything else |
| Outbound | Accept all |

### Hardening

SSH in as root, then:

```bash
adduser --disabled-password --gecos "" jacob
usermod -aG sudo jacob
rsync --archive --chown=jacob:jacob ~/.ssh /home/jacob/

# Key-only login.
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
systemctl restart ssh

apt update && apt upgrade -y
apt install -y nginx unattended-upgrades fail2ban
systemctl enable --now fail2ban
dpkg-reconfigure -plow unattended-upgrades   # answer Yes
```

**Open a second terminal and confirm `ssh jacob@<ip>` works before closing the
first one.** Everything below runs as `jacob`.

### The directory layout

```bash
sudo mkdir -p /srv/bigwalkradio/{app,media/music,media/audio}
sudo chown -R jacob:jacob /srv/bigwalkradio
```

- `app/` — the contents of `dist/`. Wiped and replaced on every deploy.
- `media/music/`, `media/audio/` — uploaded by hand. Never touched by a deploy.

### Sending up the build and the music

From your machine, in the repo:

```bash
npm run build

rsync -av --delete dist/ jacob@<ip>:/srv/bigwalkradio/app/
# No -z: Ogg and WAV are already compressed, so it only costs CPU.
rsync -av --progress music/ jacob@<ip>:/srv/bigwalkradio/media/music/
rsync -av --progress audio/ jacob@<ip>:/srv/bigwalkradio/media/audio/
```

The album folders have spaces and parentheses in their names. rsync handles
that as written — the quoting above is already correct.

### nginx

`sudo nano /etc/nginx/sites-available/bigwalkradio`:

```nginx
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;

    root /srv/bigwalkradio/app;
    index index.html;

    # The host's media, deliberately outside the deploy target.
    location /music/ {
        alias /srv/bigwalkradio/media/music/;
        types { audio/ogg ogg opus; audio/mpeg mp3; audio/flac flac; audio/wav wav; }
        default_type application/octet-stream;
        add_header Cache-Control "public, max-age=31536000";
        access_log off;
    }

    location /audio/ {
        alias /srv/bigwalkradio/media/audio/;
        types { audio/wav wav; audio/ogg ogg; }
        default_type application/octet-stream;
        add_header Cache-Control "public, max-age=31536000";
    }

    # Filenames carry a content hash, so these can be kept forever.
    location /assets/ {
        add_header Cache-Control "public, max-age=31536000, immutable";
    }

    # These change in place on every deploy, so they must not be held.
    location = /index.html          { add_header Cache-Control "no-cache"; }
    location = /sw.js               { add_header Cache-Control "no-cache"; }
    location = /manifest.webmanifest { add_header Cache-Control "no-cache"; }

    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

```bash
sudo ln -sf /etc/nginx/sites-available/bigwalkradio /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

### Checking it

The radio seeks constantly, so range requests are the thing to verify. nginx
supports them for static files out of the box, but check rather than assume:

On the server:

```bash
# A path with no spaces in it, to check the wiring.
curl -sI http://localhost/audio/sfx_prop_radio_channel_change_01.wav | head -3

# And a real track, asking for only the first kilobyte of it.
TRACK=$(cd /srv/bigwalkradio/media && find music -name '*.ogg' | head -1)
URL=$(python3 -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1]))' "$TRACK")
curl -sI -r 0-1023 "http://localhost/$URL" | head -6
```

The second one must say `HTTP/1.1 206 Partial Content` with a `Content-Range`
header and `Content-Type: audio/ogg`. A `200` there means ranges aren't being
served and every tune-in will download a whole file before it makes a sound.

Then open `http://<ip>` on your phone and press the speaker grille.

**What won't work at this stage, and why:** `http://` on a bare IP is not a
[secure context](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts),
so the browser withholds the service worker, the Media Session API (the media
keys and the lock-screen widget) and persistent storage. Audio playback,
IndexedDB and the whole UI work fine. All of it comes back in stage 2.

---

## 2. The subdomain and TLS

### DNS

In Cloudflare, on `sevenstack.net` → **DNS** → **Add record**:

| Field | Value |
| --- | --- |
| Type | A |
| Name | `radio` |
| IPv4 address | your Linode's IP |
| Proxy status | **DNS only** (grey cloud) |
| TTL | Auto |

**On grey cloud rather than orange.** Two reasons, and one cost.

- Cloudflare's self-serve terms restrict using the CDN to serve "a
  disproportionate percentage" of non-HTML content — video and audio files are
  named specifically. This app is 148 MB of music against 55 KB of page. Read
  [section 2.8](https://www.cloudflare.com/terms/) and decide for yourself, but
  grey cloud takes the question off the table.
- HTTP-01 certificate issuance and renewal just work, with no API tokens and no
  origin certificates to install.

The cost is that all bandwidth comes off your 1 TB Linode allowance, and your
origin IP is public. For scale: an hour of listening is roughly 85 MB, so 1 TB
is about 12,000 listener-hours a month. If you ever outgrow that, the move is
to proxy the app and serve the media from a separate unproxied hostname — the
audio elements already set `crossOrigin`, so it would need CORS headers and a
change to `catalog.urlFor`, not a rewrite.

### The certificate

Once `dig radio.sevenstack.net` returns your Linode's IP:

```bash
sudo sed -i 's/server_name _;/server_name radio.sevenstack.net;/' \
  /etc/nginx/sites-available/bigwalkradio
sudo nginx -t && sudo systemctl reload nginx

sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d radio.sevenstack.net
```

Choose the redirect option when it offers. certbot edits the server block in
place and installs a systemd timer for renewal; check it with
`sudo certbot renew --dry-run`.

Now `https://radio.sevenstack.net` is a secure context: the service worker
registers, the media keys work, and iOS will offer to add it to the home
screen.

---

## 3. Deploying from GitHub

### A deploy user on the server

Give CI its own account with no sudo, owning only the app directory.

```bash
sudo adduser --disabled-password --gecos "" deploy
sudo chown -R deploy:deploy /srv/bigwalkradio/app
sudo -u deploy mkdir -p /home/deploy/.ssh
sudo -u deploy chmod 700 /home/deploy/.ssh
```

The media stays owned by `jacob`, so a compromised deploy key cannot touch it.

### The key

On your machine, generate a key **used for nothing else**:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/bigwalkradio-deploy -C "github-actions" -N ""
ssh-copy-id -i ~/.ssh/bigwalkradio-deploy.pub deploy@radio.sevenstack.net
ssh-keyscan radio.sevenstack.net    # keep this output for the next step
```

### Repository secrets

`Settings → Secrets and variables → Actions → New repository secret`:

| Name | Value |
| --- | --- |
| `DEPLOY_KEY` | contents of `~/.ssh/bigwalkradio-deploy` (the private one, including both `-----` lines) |
| `DEPLOY_HOST` | `radio.sevenstack.net` |
| `DEPLOY_USER` | `deploy` |
| `KNOWN_HOSTS` | the `ssh-keyscan` output above |

`KNOWN_HOSTS` is what stops the deploy trusting whatever answers on that
address, so don't skip it in favour of `StrictHostKeyChecking=no`.

### The workflow

[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) is already in
the repo, set to **manual only** so it can't fail before the secrets exist.

Run it once by hand — Actions → Deploy → Run workflow — and when that works,
uncomment the `push` trigger at the top of the file:

```yaml
on:
  workflow_dispatch:
  push:
    branches: [main]
```

It builds and tests on the runner, so nothing but rsync happens on the Nanode.
`--delete` is safe because it only ever points at `app/`.

---

## The gotcha worth remembering

`src/core/presets.ts` — the dial — is **generated from your local `music/`
directory and committed**. CI has no music, and doesn't need any: it builds
from the committed presets.

So whenever the music on the server changes, the order is:

```bash
npm run presets       # rescans ./music, rewrites src/core/presets.ts
npm test              # 'every daypart points at a real file' catches mismatches
git commit -am "..."  # deploys the new dial
rsync -av music/ jacob@radio.sevenstack.net:/srv/bigwalkradio/media/music/
```

Deploying a build whose presets name files the server doesn't have shows up as
`N files not served` under the radio, and those channels play silence.
