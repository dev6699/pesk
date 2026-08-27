#!/usr/bin/env bash
set -euo pipefail

if ! command -v openssl >/dev/null 2>&1; then
  echo "openssl is required but was not found in PATH." >&2
  exit 1
fi

output_dir="${1:-./tls}"
shift || true

ips=("127.0.0.1")
if (($# > 0)); then
  ips=("$@")
fi

mkdir -p "$output_dir"
key_path="$output_dir/pesk-key.pem"
cert_path="$output_dir/pesk-cert.pem"

san_entries=()
for ip in "${ips[@]}"; do
  if [[ ! "$ip" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
    echo "Only IPv4 addresses are supported: $ip" >&2
    exit 1
  fi
  san_entries+=("IP:$ip")
done

san_list=$(IFS=,; echo "${san_entries[*]}")
common_name="${ips[0]}"

openssl req \
  -x509 \
  -newkey rsa:2048 \
  -nodes \
  -keyout "$key_path" \
  -out "$cert_path" \
  -days 825 \
  -subj "/CN=$common_name" \
  -addext "subjectAltName=$san_list"

chmod 600 "$key_path"
chmod 644 "$cert_path"

echo
echo "Generated:"
echo "  Private key: $key_path"
echo "  Certificate: $cert_path"
echo
echo "Add these entries to the active Pesk config.json:"
echo "  \"webTlsKey\": \"${key_path#./}\","
echo "  \"webTlsCert\": \"${cert_path#./}\""
echo
echo "SANs: $san_list"
echo "The certificate is self-signed; trust $cert_path on each client device."
