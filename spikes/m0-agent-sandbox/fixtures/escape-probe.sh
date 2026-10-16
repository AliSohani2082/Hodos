#!/bin/sh
# Executes only against this spike's canaries, dummy listeners, and reserved test addresses.
set +e
echo "identity uid=$(id -u) capeff=$(awk '/CapEff/{print $2}' /proc/self/status)"
if env | rg -q '^(CANARY_|DATABASE_URL=|SECRETS_KEY=|ADMIN_SECRET=)'; then echo "app_environment=UNEXPECTED"; else echo "app_environment=absent"; fi
if tr '\0' '\n' </proc/1/environ 2>/dev/null | rg -q '^(CANARY_|DATABASE_URL=|SECRETS_KEY=|ADMIN_SECRET=)'; then echo "pid1_app_environment=UNEXPECTED"; else echo "pid1_app_environment=absent"; fi
for path in /app.env /run/secrets/app.env /workspace/../work/canary/app.env /workspace/../checkouts/job-OTHER/SECRET.md /var/run/docker.sock /run/podman/podman.sock; do
  if test -r "$path"; then echo "file_read=UNEXPECTED:$path"; else echo "file_read=blocked:$path"; fi
done
for hostport in 'ali39-postgres 5432' 'ali39-runner 7070' 'ali39-mcp 7000' 'ali39-mcp 7001'; do
  set -- $hostport
  if nc -z -w 2 "$1" "$2" 2>/dev/null; then echo "direct_tcp=UNEXPECTED:$1:$2"; else echo "direct_tcp=blocked:$1:$2"; fi
done
for url in 'http://192.168.1.101:19939/' 'http://192.168.1.250:19939/' 'http://169.254.169.254/latest/meta-data/' 'https://1.1.1.1/' 'https://example.com/'; do
  code=$(env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy curl -sS --connect-timeout 2 --max-time 3 -o /tmp/ali39-escape-body -w '%{http_code}' "$url" 2>/dev/null)
  [ "$code" = 200 ] && result=UNEXPECTED || result=blocked
  echo "direct_http=$result:$url:${code:-000}"
done
dns=$(getent hosts example.com 2>/dev/null | head -1)
[ -n "$dns" ] && result=UNEXPECTED || result=blocked
echo "dns_example_com=$result"
for host in example.com 127.0.0.1 169.254.169.254 ali39-postgres; do
  curl -sv --connect-timeout 2 --max-time 3 -x http://ali39-proxy:8080 "https://$host/" -o /dev/null 2>/tmp/ali39-curl.err
  code=$?
  if grep -q '403 Forbidden' /tmp/ali39-curl.err; then result=denied; else result="not-established(exit=$code)"; fi
  echo "proxy_connect_$host=$result"
done
code=$(curl -sS --max-time 3 -o /tmp/ali39-escape-body -w '%{http_code}' -x http://ali39-proxy:8080 http://example.com/ 2>/dev/null)
echo "proxy_absolute_http=${code:-000}"
code=$(curl -sS --max-time 3 -o /tmp/ali39-escape-body -w '%{http_code}' http://ali39-proxy:8080/admin/jobs 2>/dev/null)
echo "proxy_admin_route=${code:-000}"
