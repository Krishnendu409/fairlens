try:
    from .model_runner import run_task
    from .skills import build_prompt, detect_task_type
    from .utils import append_benchmark_log
except ImportError:  # script execution fallback
    from model_runner import run_task
    from skills import build_prompt, detect_task_type
    from utils import append_benchmark_log


def solve_problem(problem: str) -> str:
    task_type = detect_task_type(problem)
    print(f"\n[DETECTED TASK]: {task_type}")

    prompt = build_prompt(problem, task_type)
    result = run_task(task_type, prompt)

    append_benchmark_log(
        {
            "task_type": task_type,
            "model": result.get("model"),
            "latency": result.get("latency"),
            "success": result.get("status") == "ok",
            "attempts": result.get("attempts"),
            "used_fallback": bool(result.get("used_fallback", False)),
            "error": result.get("error", ""),
        }
    )

    if result.get("status") != "ok":
        return f"MODEL_FAILED: {result.get('error', 'Unknown error')}"
    return str(result.get("response", ""))


def main() -> None:
    print("=== AI SYSTEM (GENERAL PROBLEM SOLVER) ===")

    while True:
        user_input = input("\nEnter problem (or 'exit'): ").strip()
        if user_input.lower() == "exit":
            break
        if not user_input:
            print("Please enter a problem.")
            continue

        result = solve_problem(user_input)
        print("\n=== RESULT ===\n")
        print(result)


if __name__ == "__main__":
    main()
