from pathlib import Path

from utils import load_skill_text

SKILLS_DIR = Path(__file__).resolve().parents[1] / "skills"
PROMPT_TEMPLATES_DIR = SKILLS_DIR / "prompt_templates"


CODING_KEYWORDS = {
    "code",
    "coding",
    "api",
    "function",
    "bug",
    "fix",
    "debug",
    "endpoint",
    "script",
    "implementation",
}

CRITIC_KEYWORDS = {
    "critique",
    "review",
    "evaluate",
    "assessment",
    "improve",
    "weakness",
    "risk",
    "test",
    "validate",
}


def detect_task_type(problem: str) -> str:
    lowered = problem.lower()
    coding_score = sum(1 for kw in CODING_KEYWORDS if kw in lowered)
    critic_score = sum(1 for kw in CRITIC_KEYWORDS if kw in lowered)

    if coding_score > critic_score and coding_score > 0:
        return "coding"
    if critic_score > coding_score and critic_score > 0:
        return "critic"
    return "reasoning"


def _template_for(task_type: str) -> str:
    path = PROMPT_TEMPLATES_DIR / f"{task_type}.md"
    default = (
        "You are an expert AI system.\\n\\n"
        "Problem:\\n{problem}\\n\\n"
        "Provide a clear and structured answer."
    )
    return load_skill_text(path, default=default)


def build_prompt(problem: str, task_type: str) -> str:
    template = _template_for(task_type)
    output_structure = load_skill_text(SKILLS_DIR / "output_structure.md")

    sections = [template.format(problem=problem)]

    if task_type == "coding":
        sections.append(load_skill_text(SKILLS_DIR / "code_generation.md"))
    elif task_type == "critic":
        sections.append(load_skill_text(SKILLS_DIR / "critique_checklist.md"))

    sections.append(output_structure)
    return "\n\n".join(part for part in sections if part)
