/** True for "file or directory does not exist" errors from fs. */
export const isNotFound = (e: unknown): boolean => (e as NodeJS.ErrnoException | null)?.code === "ENOENT";
