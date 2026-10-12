"""A tiny report service used by the layerdelta example."""

import json
import sys

import requests


def main() -> None:
    url = sys.argv[1] if len(sys.argv) > 1 else "https://api.github.com/repos/python/cpython"
    data = requests.get(url, timeout=10).json()
    json.dump({"name": data.get("full_name"), "stars": data.get("stargazers_count")}, sys.stdout)


if __name__ == "__main__":
    main()
