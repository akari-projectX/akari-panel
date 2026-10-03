#!/usr/bin/env bash
# Run every fuzz target for SECS seconds each (default 30) on its committed
# seeds (seeds/<target>) plus the local/CI-cached corpus (corpus/<target>).
# Debug assertions and overflow checks stay on (cargo-fuzz default build).
# Prints a summary (executions, coverage edges, corpus size); exits non-zero
# if any target crashed — the reproducer is in artifacts/<target>/.
#   ./run.sh 600              # all targets, 10 min each
#   ./run.sh 60 csr domain    # some targets
set -uo pipefail
cd "$(dirname "$0")" || exit 1
secs=${1:-30}
shift || true
targets=("$@")
if [ ${#targets[@]} -eq 0 ]; then
	mapfile -t targets < <(cargo fuzz list)
fi
cargo fuzz build || exit 1
mkdir -p logs
summary="| target | seconds | executions | coverage (edges) | corpus | result |\n|---|---:|---:|---:|---:|---|\n"
failed=0
for t in "${targets[@]}"; do
	mkdir -p "corpus/$t" "artifacts/$t"
	log="logs/$t.log"
	cargo fuzz run "$t" "corpus/$t" "seeds/$t" -- \
		-max_total_time="$secs" -rss_limit_mb=2048 -max_len=16384 \
		-timeout=10 -print_final_stats=1 >"$log" 2>&1
	rc=$?
	execs=$(grep -oE 'stat::number_of_executed_units: [0-9]+' "$log" | grep -oE '[0-9]+$' | tail -1)
	cov=$(grep -oE 'cov: [0-9]+' "$log" | tail -1 | grep -oE '[0-9]+')
	corp=$(find "corpus/$t" -type f | wc -l)
	if [ $rc -eq 0 ]; then res=ok; else res="**CRASH**"; failed=1; tail -n 40 "$log"; fi
	summary+="| $t | $secs | ${execs:-?} | ${cov:-?} | $corp | $res |\n"
	echo "== $t: rc=$rc execs=${execs:-?} cov=${cov:-?} corpus=$corp"
done
printf "%b" "$summary"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
	printf "### Fuzzing (%ss per target)\n\n%b" "$secs" "$summary" >>"$GITHUB_STEP_SUMMARY"
fi
exit $failed
