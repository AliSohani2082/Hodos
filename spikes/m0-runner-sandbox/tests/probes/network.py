import sys, os, errno
def obs(k, v): print(f"OBS {k}={v}", flush=True)
import socket
obs("interfaces", [l.split(":")[0].strip() for l in open("/proc/net/dev").read().splitlines()[2:]])
obs("routes", open("/proc/net/route").read().count("\n") - 1)
def tcp(label, host, port):
    s = socket.socket(); s.settimeout(1.5)
    try: s.connect((host, port)); r = "CONNECTED"
    except OSError as e: r = errno.errorcode.get(e.errno, type(e).__name__) if e.errno else type(e).__name__
    finally: s.close()
    obs("tcp." + label, r)
tcp("host_loopback_canary", "127.0.0.1", @@CANARY_LOOP@@)
tcp("host_lan_canary", "@@HOST_IP@@", @@CANARY_ALL@@)
tcp("public_dns_53", "1.1.1.1", 53)
tcp("public_443", "93.184.216.34", 443)
u = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); u.settimeout(1.5)
try: u.sendto(b"\x00" * 12, ("1.1.1.1", 53)); u.recvfrom(512); r = "ANSWERED"
except OSError as e: r = errno.errorcode.get(e.errno, type(e).__name__) if e.errno else type(e).__name__
obs("udp.dns_1.1.1.1", r)
try: socket.getaddrinfo("example.com", 80); r = "RESOLVED"
except OSError as e: r = "FAILED:" + type(e).__name__
obs("dns.example.com", r)
a = socket.socket(socket.AF_UNIX); a.settimeout(1)
try: a.connect("\0ali40-host-canary"); r = "CONNECTED"
except OSError as e: r = errno.errorcode.get(e.errno, type(e).__name__)
obs("unix_abstract.host_canary", r)
try: socket.socket(socket.AF_INET, socket.SOCK_RAW, socket.IPPROTO_ICMP); r = "OPENED"
except OSError as e: r = errno.errorcode.get(e.errno, type(e).__name__)
obs("raw_socket", r)
try: socket.socket(socket.AF_PACKET, socket.SOCK_RAW); r = "OPENED"
except (OSError, AttributeError) as e: r = errno.errorcode.get(getattr(e, "errno", 0) or 0, type(e).__name__)
obs("af_packet", r)
