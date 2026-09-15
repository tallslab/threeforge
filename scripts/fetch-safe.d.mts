/**
 * The local path to write `uri` (a remote-derived, possibly percent-encoded relative name) into, confined to `root`.
 * Throws for a non-string/empty uri, a NUL byte, a backslash, a URI scheme, an absolute path, undecodable
 * percent-encoding, or a decoded path that resolves outside `root` (including through an existing symlink).
 * Returns `join(root, decodeURIComponent(uri))` otherwise.
 */
export function safeLocalPath(root: string, uri: string): string;
