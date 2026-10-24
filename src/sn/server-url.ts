export function serverUrl(): string {
  // Empty means unset, as for every SN_* variable.
  const value = process.env.SN_SERVER_URL || "https://api.standardnotes.com";
  const url = new URL(value);
  const localTest = process.env.SN_ALLOW_LOCAL_TEST_SERVER === "1" && url.hostname === "127.0.0.1" && url.protocol === "http:";
  if ((url.protocol !== "https:" && !localTest) || url.username || url.password || url.search || url.hash) {
    throw new Error("HTTPS required without URL credentials/query/fragment; HTTP is allowed only for explicit loopback tests");
  }
  return value;
}
