/** Russian plural: plural(5, ['человек', 'человека', 'человек']). */
export function plural(n: number, [one, few, many]: [string, string, string]): string {
  const mod10 = n % 10, mod100 = n % 100;
  const word = mod10 === 1 && mod100 !== 11 ? one : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? few : many;
  return `${n} ${word}`;
}
