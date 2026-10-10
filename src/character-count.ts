/**
 * Model-facing rendering of a character budget, shared by the reminder and the
 * guidance so both state the same number.
 *
 * @module dsh-context-rollover/character-count
 */

/**
 * Format a character count with comma thousands separators.
 * @param count - a non-negative integer character count.
 * @returns the digits with a comma before each group of three, for example `20,000`.
 */
export function formatCharacterCount(count: number): string {
  return String(count).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}
