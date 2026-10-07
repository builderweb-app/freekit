def factorial(n: int) -> int:
    """Return the factorial of n using recursion.

    Args:
        n: A non-negative integer.

    Returns:
        The factorial of n (n!).

    Raises:
        ValueError: If n is negative.
        TypeError: If n is not an integer.
    """
    if not isinstance(n, int):
        raise TypeError("n must be an integer")
    if n < 0:
        raise ValueError("n must be a non-negative integer")
    if n == 0 or n == 1:
        return 1
    return n * factorial(n - 1)


if __name__ == "__main__":
    for i in range(10):
        print(f"{i}! = {factorial(i)}")
