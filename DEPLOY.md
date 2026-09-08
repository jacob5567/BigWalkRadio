# Deploying Big Walk Radio

Three stages, in the order you'll want them:

1. [A working server on its IP](#1-a-working-server) — proves the files are in
   place and nginx serves them.
2. [bigwalkradio.stream, with TLS](#2-the-domain-and-tls) — the real thing.
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

Do this in two halves, and **prove you can get in between them**. Disabling
both root login and password login before checking is how people lock
themselves out; if it happens to you, see [Locked out](#locked-out).

SSH in as root:

```bash
# adduser prompts for a password. Set one: sudo asks for it later, so an
# account created with --disabled-password cannot sudo at all.
adduser jacob
usermod -aG sudo jacob

# Hand over the key you gave the Linode at creation, if you gave it one.
mkdir -p /home/jacob/.ssh
cp /root/.ssh/authorized_keys /home/jacob/.ssh/authorized_keys 2>/dev/null || true
chown -R jacob:jacob /home/jacob/.ssh
chmod 700 /home/jacob/.ssh
chmod 600 /home/jacob/.ssh/authorized_keys 2>/dev/null || true

apt update && apt upgrade -y
apt install -y nginx unattended-upgrades fail2ban
dpkg-reconfigure -plow unattended-upgrades   # answer Yes

# Your own address, so a run of failed logins while you set this up cannot
# lock you out of your own box. Get it with: curl -4 -s ifconfig.me
cat >/etc/fail2ban/jail.local <<'EOF'
[DEFAULT]
ignoreip = 127.0.0.1/8 ::1 YOUR.IP.HERE
bantime  = 1h
findtime = 10m
maxretry = 5
EOF
# Left stopped on purpose: start it once key login is proven, at the end.
```

Now, **from your own machine, leaving the root session open**:

```bash
ssh-copy-id jacob@<ip>   # only needed if the cp above found nothing
ssh jacob@<ip>
sudo -v                  # must succeed before you go on
```

Only once both of those work, shut the doors:

```bash
# Ubuntu 24.04 reads this directory BEFORE /etc/ssh/sshd_config, and the
# first value of a setting wins -- so editing sshd_config alone can silently
# do nothing against a cloud-init drop-in. A file that sorts first wins.
printf 'PasswordAuthentication no\nPermitRootLogin no\nKbdInteractiveAuthentication no\n' \
  | sudo tee /etc/ssh/sshd_config.d/00-hardening.conf
sudo sshd -t && sudo systemctl restart ssh

# The effective config, includes and all. This is the check that counts.
sudo sshd -T | grep -Ei 'passwordauthentication|permitrootlogin'
```

Open one more fresh terminal and confirm `ssh jacob@<ip>` still works before
closing anything. Then, and only then, start the thing that bans people:

```bash
sudo systemctl enable --now fail2ban
sudo fail2ban-client status sshd
```

Everything below runs as `jacob`.

### Locked out

Linode's **Lish** console (Linode dashboard → your instance → Launch LISH
Console) logs in with the root password and is not affected by any of the SSH
settings above. From there:

```bash
passwd jacob                 # in case the account has no password
printf 'PasswordAuthentication yes\nPermitRootLogin prohibit-password\n' \
  > /etc/ssh/sshd_config.d/00-recovery.conf
sshd -t && systemctl restart ssh
```

Get in with `ssh-copy-id jacob@<ip>`, check `sudo -v`, then delete
`00-recovery.conf` and redo the hardening step above.

**If it says `Connection refused`**, work out first whether anything is
listening, because the same message covers two very different faults:

```bash
ss -ltnp | grep -w 22
```

*Something is listening on `0.0.0.0:22`* -- then it is fail2ban, which bans by
rejecting with ICMP port-unreachable, and Linux reports that to the client as
`Connection refused`. It is your own address that got banned, so port 80 still
answers and only SSH refuses:

```bash
fail2ban-client status sshd        # your address is under Banned IP list
systemctl stop fail2ban            # stand it down until SSH is sorted
fail2ban-client set sshd unbanip <your ip>   # or just this, to stay protected
```

*Nothing is listening* -- then sshd is not running. A rejected config leaves
`systemctl restart` with the old daemon stopped and no new one started:

```bash
sshd -t                       # silent means the config parses
systemctl status ssh ssh.socket --no-pager -l | head -30
journalctl -u ssh -n 30 --no-pager
```

`sshd -t` names the file and line if a drop-in is malformed. Clear the ones
this guide added, put back a known-good one, and start it:

```bash
rm -f /etc/ssh/sshd_config.d/00-hardening.conf /etc/ssh/sshd_config.d/00-recovery.conf
printf 'PermitRootLogin prohibit-password\nPasswordAuthentication yes\n' \
  > /etc/ssh/sshd_config.d/00-recovery.conf
sshd -t && systemctl restart ssh
systemctl start ssh.socket 2>/dev/null   # 24.04 socket-activates sshd
ss -ltnp | grep -w 22
```

A `Connection refused` is something answering with a refusal, so it is almost
never the Linode Cloud Firewall -- that drops packets, which shows up as a
timeout instead. Check `ufw status verbose` all the same, and `ufw allow
OpenSSH` if it is active without a rule for it.

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

## 2. The domain and TLS

### Putting the zone on Cloudflare

`bigwalkradio.stream` is its own domain rather than a subdomain of an existing
zone, so Cloudflare has to be given it first:

1. Cloudflare dashboard → **Add a site** → `bigwalkradio.stream` → Free plan.
2. Cloudflare hands you two nameservers.
3. At the registrar you bought `.stream` from, replace the existing
   nameservers with those two. (Cloudflare Registrar doesn't sell `.stream`,
   so this stays wherever you bought it.)
4. Wait for Cloudflare to mark the zone **Active** — usually minutes, up to a
   day. It emails you.

### DNS

Then **DNS** → **Add record**, twice:

| Type | Name | IPv4 address | Proxy status |
| --- | --- | --- | --- |
| A | `@` | your Linode's IP | **DNS only** (grey cloud) |
| A | `www` | your Linode's IP | **DNS only** (grey cloud) |

`@` is the apex — `bigwalkradio.stream` itself. The `www` record exists only so
that people who type it get redirected; see the note below about why the radio
must live on exactly one origin.

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

### One origin, not two

A browser keys a service worker, its caches and IndexedDB to the **origin**.
`https://bigwalkradio.stream` and `https://www.bigwalkradio.stream` are two
different origins, so a listener who arrived at one and later at the other
would find a second radio: its own remembered channel, its own volume, its own
installed copy on the home screen.

So `www` redirects, and never serves. Point the app at the apex:

```bash
sudo sed -i 's/server_name _;/server_name bigwalkradio.stream;/' \
  /etc/nginx/sites-available/bigwalkradio
```

and add the redirect as its own file,
`sudo nano /etc/nginx/sites-available/bigwalkradio-www`:

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name www.bigwalkradio.stream;
    return 301 https://bigwalkradio.stream$request_uri;
}
```

```bash
sudo ln -sf /etc/nginx/sites-available/bigwalkradio-www /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

### The certificate

Once `dig +short bigwalkradio.stream` returns your Linode's IP:

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d bigwalkradio.stream -d www.bigwalkradio.stream
```

Both names, so the redirect can be served over HTTPS too — otherwise anyone
reaching `https://www.` gets a certificate warning before the redirect ever
runs. Choose the redirect option when certbot offers it. It edits the server
blocks in place and installs a systemd timer for renewal; check that with
`sudo certbot renew --dry-run`.

Now `https://bigwalkradio.stream` is a secure context: the service worker
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
ssh-copy-id -i ~/.ssh/bigwalkradio-deploy.pub deploy@bigwalkradio.stream
ssh-keyscan bigwalkradio.stream    # keep this output for the next step
```

### Repository secrets

`Settings → Secrets and variables → Actions → New repository secret`:

| Name | Value |
| --- | --- |
| `DEPLOY_KEY` | contents of `~/.ssh/bigwalkradio-deploy` (the private one, including both `-----` lines) |
| `DEPLOY_HOST` | `bigwalkradio.stream` |
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
rsync -av music/ jacob@bigwalkradio.stream:/srv/bigwalkradio/media/music/
```

Deploying a build whose presets name files the server doesn't have shows up as
`N files not served` under the radio, and those channels play silence.
