/**
 * Install-pipeline errors. Carry a stable `code` so the CLI can map them to
 * the right exit status / message. See `wiki design-phase-3-install.md` Part 6.
 */
export type InstallErrorCode =
  | 'TARGET_UNSUPPORTED' // no adapter registered for this target (e.g. zcode)
  | 'TARGET_MISMATCH' // --target differs from a target-bound profile's own target
  | 'RESOLVE_FAILED' // SDK fetch of profile or a referenced resource failed
  | 'VALIDATION_FAILED' // adapter.validate() returned blocking issues
  | 'APPLY_FAILED' // a filesystem operation failed during apply
  | 'UNSAFE_DESTINATION' // an operation tried to write outside the install root (#21)
  | 'DAEMON_LOCKED'; // another daemon-owning process holds the machine lock (#39)

export class InstallError extends Error {
  constructor(
    message: string,
    readonly code: InstallErrorCode,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'InstallError';
  }
}
