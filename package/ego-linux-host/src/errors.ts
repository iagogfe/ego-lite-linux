/** Build a thrown Error carrying a stable `error_code`. */
export function makeEgoError(
  code: string,
  message: string,
): Error & { error_code: string } {
  const err = new Error(message) as Error & { error_code: string };
  err.error_code = code;
  return err;
}
