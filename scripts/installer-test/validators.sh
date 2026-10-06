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

grep_v=$({ grep --version 2>/dev/null || busybox 2>&1; } | sed -n 1p)
if [ "$fails" -ne 0 ]; then
	echo "validators: $fails failure(s) (grep: $grep_v)"
	exit 1
fi
echo "validators: ok (grep: $grep_v)"
