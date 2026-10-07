import { greet } from "./index";
import { add, divide } from "./utils";

// Test 1: greet
const greeting = greet("World");
if (greeting !== "Hello, World!") {
  throw new Error(`Test 1 failed: expected "Hello, World!", got "${greeting}"`);
}

// Test 2: add
const sum = add(2, 3);
if (sum !== 5) {
  throw new Error(`Test 2 failed: expected 5, got ${sum}`);
}

// Test 3: divide by zero
try {
  divide(10, 0);
  throw new Error("Test 3 failed: expected division by zero to throw");
} catch (err: any) {
  if (err.message !== "Division by zero") {
    throw err;
  }
}

console.log("All tests passed!");

