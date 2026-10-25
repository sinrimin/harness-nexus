// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

/** Use Roder's checksum-verifying native installer; it has no npm CLI package. */
export function roderInstallCommand(
  payload: { action: string; version?: string | undefined },
  installMethod: string | undefined,
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[] } | { error: string } {
  if (payload.action === 'apply-config') {
    return { error: 'apply-config is executed by the config writer' };
  }
  if (platform !== 'linux' && platform !== 'darwin') {
    return { error: 'Roder native installation supports Linux and macOS only' };
  }
  // Avoid shadowing a Homebrew-managed binary with ~/.local/bin/roder.
  if (installMethod === 'brew') {
    return {
      error: 'Roder is managed by Homebrew; upgrade or pin it with Homebrew on the machine',
    };
  }
  if (payload.action === 'pin' && payload.version === undefined) {
    return { error: 'pin requires a release version' };
  }
  if (
    payload.version !== undefined &&
    !/^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(payload.version)
  ) {
    return { error: 'Roder version must be a release version such as 0.3.19' };
  }
  const tag =
    payload.version === undefined ? 'latest' : `roder/v${payload.version.replace(/^v/, '')}`;
  const base = `https://github.com/RoderAI/roder/releases/download/${tag}`;
  return {
    command: 'bash',
    args: [
      '-c',
      'set -eu; tmp=$(mktemp -d); trap \'rm -rf "$tmp"\' EXIT; ' +
        'curl -fsSL https://github.com/RoderAI/roder/releases/download/latest/install.sh -o "$tmp/install.sh"; ' +
        'RODER_DOWNLOAD_BASE_URL="$1" RODER_BUILD_FROM_SOURCE=0 bash "$tmp/install.sh"',
      'hnx-roder-install',
      base,
    ],
  };
}
