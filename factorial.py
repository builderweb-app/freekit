
def factorial(n: int) -> int:
    """Calculate the factorial of a non-negative integer recursively."""
    if n < 0:
        raise ValueError("Factorial is not defined for negative integers")
    if n <= 1:
        return 1
    return n * factorial(n - 1)

if __name__ == "__main__":
    print(factorial(5))  # Output: 120
