export function formatPrice(
  rawInput: string,
  rawOutput: string,
  inputDecimals: number = 9,
  outputDecimals: number = 9
): string {
  try {
    const outputValue = Number(rawOutput) / Math.pow(10, outputDecimals);
    const inputValue = Number(rawInput) / Math.pow(10, inputDecimals);

    if (inputValue === 0) return "0.000000000";

    return (outputValue / inputValue).toFixed(9);
  } catch (error) {
    console.error("Error in formatPrice:", error);
    return "0.000000000";
  }
}
