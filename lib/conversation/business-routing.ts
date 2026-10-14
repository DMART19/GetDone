import type { Business } from "@/lib/businesses/contracts";

/** Advisory routing guard. Never substitutes for server-side membership checks. */
export function mentionedAuthorizedBusinesses(
  message: string,
  businesses: readonly Business[]
): readonly Business[] {
  const text = message.toLocaleLowerCase();
  return businesses.filter(business => {
    const name = business.name.trim().toLocaleLowerCase();
    if (name.length < 3) return false;
    // Require a complete name bounded by non-alphanumeric characters.
    let position = text.indexOf(name);
    while (position !== -1) {
      const before = position === 0 ? "" : text[position - 1];
      const after = text[position + name.length] ?? "";
      if ((!before || !/[\p{L}\p{N}]/u.test(before)) && (!after || !/[\p{L}\p{N}]/u.test(after))) return true;
      position = text.indexOf(name, position + 1);
    }
    return false;
  });
}
