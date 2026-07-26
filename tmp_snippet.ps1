try {
    Fail @"
No package manager (winget / scoop / choco) was found and Scoop install failed.
Install one of these manually, then re-run:
  • winget  — built into Windows 10/11; update from Microsoft Store
  • scoop   — https://scoop.sh
  • choco   — https://chocolatey.org/install
"@
}

