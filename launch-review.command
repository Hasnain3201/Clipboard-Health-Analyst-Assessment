#!/bin/zsh
set -eu
cd "${0:A:h}"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
url='http://127.0.0.1:4391/'
review_is_ready() {
  curl --silent --fail --max-time 1 "$url" | grep -q 'Bellhaven | CRM Review'
}
if review_is_ready; then
  open "$url"
  exit 0
fi
printf '\nOpening Bellhaven Review at %s. Leave this window open while reviewing.\n\n' "$url"
(
  for attempt in {1..30}; do
    if review_is_ready; then
      open "$url"
      break
    fi
    sleep 0.2
  done
) &
exec node --disable-warning=ExperimentalWarning app.mjs serve
