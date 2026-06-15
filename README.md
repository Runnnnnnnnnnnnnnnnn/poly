# Poly

Polymarket-related project foundation for GitHub Pages.

## Target GitHub Account

This repository is intended to live under:

```text
runnnnnnnn/poly
```

The GitHub Pages URL will be:

```text
https://runnnnnnnn.github.io/poly/
```

## Local Preview

This project is static and does not require Node.js.

```sh
python3 -m http.server 8000
```

Then open:

```text
http://localhost:8000/
```

## Deploy

1. Create a repository named `poly` under the `runnnnnnnn` GitHub account.
2. Push `main` to that repository.
3. In GitHub, open `Settings` -> `Pages`.
4. Set `Build and deployment` to `GitHub Actions`.
5. The included workflow deploys the static site on every push to `main`.

## Notes

- Keep private API keys out of this repository. GitHub Pages is a public static host.
- Browser-side API calls must use public endpoints or a separate backend/proxy.
- If this becomes a trading or portfolio tool, add explicit risk and data-source disclaimers before launch.
