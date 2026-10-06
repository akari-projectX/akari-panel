#!/bin/sh
# The installer's input validators (scripts/install.sh valid_*) against
# accepted and rejected values, with whatever sh and grep run this script
# (`make shellcheck`: dash + GNU grep; CI job shellcheck also runs it with
# busybox sh + busybox grep in an alpine container). Regular expressions differ between greps
# (a `\]` in a bracket expression works with ugrep, not with GNU grep), so
# the validators are tested where the installer and the node installer run.
#
#   scripts/installer-test/validators.sh
set -eu

root=$(cd "$(dirname "$0")/../.." && pwd)
# shellcheck disable=SC1091 # linted on its own
AKARI_INSTALL_LIB=1 . "$root/scripts/install.sh"

fails=0
check() { # check ok|bad FUNCTION VALUE
	if "$2" "$3"; then got=ok; else got=bad; fi
	if [ "$got" != "$1" ]; then
		printf 'FAIL: %s %s: want %s, got %s\n' "$2" "$3" "$1" "$got"
		fails=$((fails + 1))
	fi
}

for v in edge-node-communication.911920.xyz node.myapp.test a.b 1.2.3.4 1.2.3.4:8443 \
	a.b:1 a.b:65535 '[::1]' '[::1]:8443' '[2001:db8::1]:443' 2001:db8::1 ::1 '[::ffff:1.2.3.4]:9'; do
	check ok valid_node_addr "$v"
done
for v in '' a- a localhost a.b: a.b:0 a.b:08443 a.b:65536 a.b:123456 a.b:x '[::1' '[::1]:' \
	'[::1]x' '[a.b]' -a.b a-.b a..b .a.b 'a b.c' a_b.c 'a.b/c' https://a.b '[]' '[]:1' \
	"$(printf '%064d' 0).b" "a.b
c" "a.b:1
x" "[::1]
1"; do
	check bad valid_node_addr "$v"
done
check ok valid_node_addr "$(printf '%063d' 0).b"

for v in myapp.test a.b.c xn--fiqs8s.cn 1-2.example localhost; do check ok valid_domain "$v"; done
for v in '' a- -a a..b a.b. 'a_b.c' "$(printf '%064d' 0).b" "a.b
c"; do check bad valid_domain "$v"; done
for v in 1.2.3.4 2001:db8::1 ::1; do check ok valid_ip "$v"; done
for v in '' 1.2.3.4/24 '[::1]' 'a b' x; do check bad valid_ip "$v"; done
for v in a@b.c a.b+c_d%e-f@x-y.z; do check ok valid_email "$v"; done
for v in '' a@ @b 'a b@c.d' a@b/c; do check bad valid_email "$v"; done
for v in admin@myapp.test admin@akari.invalid a.b+c@x-y.example.org; do check ok valid_admin "$v"; done
for v in '' Admin@x.org admin@x admin@x.o "$(printf '%065d' 0)@x.org"; do check bad valid_admin "$v"; done

# Cloudflare detection (check_node_addr): the installer's list is the
# panel's src/cloudflare_ips.txt.
want=$(sed 's/#.*//' "$root/src/cloudflare_ips.txt" | tr -s ' \n' '\n' | sed '/^$/d')
# shellcheck disable=SC2086 # one range per word
got=$(printf '%s\n' $CF_RANGES)
if [ "$want" != "$got" ]; then
	echo "FAIL: CF_RANGES in install.sh differs from src/cloudflare_ips.txt"
	fails=$((fails + 1))
fi
for v in 104.16.0.1 104.23.255.255 172.67.1.1 162.159.0.1 2606:4700::6810:84e5 2606:4700:10::1 \
	2a06:98c0::1 2a06:98c7:ffff::1 2c0f:f248::; do
	check ok cloudflare_ip "$v"
done
for v in 104.15.255.255 104.32.0.1 1.1.1.1 89.106.76.46 127.0.0.1 2606:4701::1 2a06:98c8::1 \
	2001:db8::1 ::1 ::ffff:104.16.0.1 '' x 1.2.3 1.2.3.4.5 01.2.3.4 256.1.1.1 '1.2.3.4
5'; do
	check bad cloudflare_ip "$v"
done
for v in 89.106.76.46 8.8.8.8 172.32.0.1; do check ok public_ipv4 "$v"; done
for v in 10.1.2.3 172.16.0.1 192.168.1.1 100.64.0.1 127.0.0.1 169.254.1.1 0.0.0.0 x; do check bad public_ipv4 "$v"; done
for pair in 'a.b:8443=a.b' 'a.b=a.b' '[::1]:8443=::1' '[2001:db8::1]=2001:db8::1' '2001:db8::1=2001:db8::1' '1.2.3.4:9=1.2.3.4'; do
	[ "$(node_host "${pair%%=*}")" = "${pair#*=}" ] || {
		echo "FAIL: node_host ${pair%%=*}"
		fails=$((fails + 1))
	}
done
# check_node_addr with a stub resolver: the main domain (or the given node
# address) behind Cloudflare stops a non-interactive install; grey-cloud
# names, IPs and unresolved names keep the default.
host_ips() {
	case "$1" in
	orange.example) printf '104.16.1.1\n2606:4700::1\n' ;;
	grey.example) printf '203.0.113.7\n' ;;
	esac
}
node_case() { # node_case ok|bad DOMAIN NODE_ADDR
	if (DOMAIN=$2 NODE_ADDR=$3 INTERACTIVE=0 GRPC_PORT=8443 && check_node_addr) >/dev/null 2>&1; then got=ok; else got=bad; fi
	if [ "$got" != "$1" ]; then
		printf 'FAIL: check_node_addr domain=%s node=%s: want %s, got %s\n' "$2" "$3" "$1" "$got"
		fails=$((fails + 1))
	fi
}
node_case ok grey.example ''
node_case ok unresolved.example ''
node_case ok '' ''
node_case bad orange.example ''
node_case ok orange.example grey.example
node_case ok orange.example 203.0.113.7:8443
node_case ok orange.example '[2001:db8::1]:8443'
node_case bad orange.example orange.example:8443
node_case bad grey.example orange.example

grep_v=$({ grep --version 2>/dev/null || busybox 2>&1; } | sed -n 1p)
if [ "$fails" -ne 0 ]; then
	echo "validators: $fails failure(s) (grep: $grep_v)"
	exit 1
fi
echo "validators: ok (grep: $grep_v)"
