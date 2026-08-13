# Team Skills Repository Implementation Plan

> Historical execution plan: this plan published the `v1.0.0` skills package. The current v2 bundled-method work follows [Bundled Method Dependencies Implementation Plan](2026-08-13-bundled-method-dependencies.md).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish a real public `nalanchujian/ai-workflow-skills` repository that a normal AI Workflow user can install and use to initialize a standard TypeScript Web task.

**Architecture:** Keep team guidance in a separate Git repository. Six declarative `SKILL.md` files map the six executable phases to locked Superpowers methods; one `PROFILE.yaml` maps the fixed workflow to exact skill versions. The existing `aiw` CLI clones, validates and locks this repository without new runtime code.

**Tech Stack:** GitHub public Git repository, YAML front matter, Markdown, existing Node.js TypeScript CLI, pnpm/Vitest validation.

## Global Constraints

- Repository name is exactly `nalanchujian/ai-workflow-skills` and visibility is public.
- Do not include executable scripts, credentials, business source code or copied Superpowers method text.
- Every `SKILL.md` must include valid front matter plus `输入`、`步骤`、`验证` headings.
- Every skill uses version `1.0.0` and a `configured:superpowers` method source at version `6.2.0`.
- The profile name is exactly `standard-web-feature`, version `1.0.0`, and maps all six executable stages.

---

## File Structure

- Create in `nalanchujian/ai-workflow-skills`: `README.md` — installation, configuration and contribution boundary.
- Create in `nalanchujian/ai-workflow-skills`: `skills/requirements-clarification/SKILL.md` — clarify-stage controlled guidance.
- Create in `nalanchujian/ai-workflow-skills`: `skills/technical-solution/SKILL.md` — solution-stage controlled guidance.
- Create in `nalanchujian/ai-workflow-skills`: `skills/implementation-planning/SKILL.md` — plan-stage controlled guidance.
- Create in `nalanchujian/ai-workflow-skills`: `skills/typescript-web-implementation/SKILL.md` — implementation-stage controlled guidance.
- Create in `nalanchujian/ai-workflow-skills`: `skills/web-verification/SKILL.md` — verification-stage controlled guidance.
- Create in `nalanchujian/ai-workflow-skills`: `skills/acceptance-testing/SKILL.md` — test-stage controlled guidance.
- Create in `nalanchujian/ai-workflow-skills`: `profiles/standard-web-feature/PROFILE.yaml` — fixed six-stage skill mapping.
- Modify in `ai-workflow`: `README.md` and `docs/07-发布运营/用户使用手册.md` — replace placeholder source with the public repository URL.

### Task 1: Create and populate the public skills repository

**Files:**
- Create: `README.md`
- Create: `skills/*/SKILL.md` (six files)
- Create: `profiles/standard-web-feature/PROFILE.yaml`

**Interfaces:**
- Consumes: `aiw` v1 skills-package contract from `docs/03-方案设计/02-核心规范/技能包规范.md`.
- Produces: a Git repository whose root can be passed to `aiw skills install <url>`.

- [x] **Step 1: Create the repository with a public default branch**

Run:

```bash
gh repo create nalanchujian/ai-workflow-skills --public --clone
cd ai-workflow-skills
git checkout -b main
```

Expected: the repository URL is `https://github.com/nalanchujian/ai-workflow-skills` and `git branch --show-current` prints `main`.

- [x] **Step 2: Add the profile and six valid skill front matters**

Create `profiles/standard-web-feature/PROFILE.yaml`:

```yaml
name: standard-web-feature
version: 1.0.0
description: 适用于 TypeScript Web 业务需求的标准七阶段方法。
skills:
  clarify: requirements-clarification@1.0.0
  solution: technical-solution@1.0.0
  plan: implementation-planning@1.0.0
  implement: typescript-web-implementation@1.0.0
  verify: web-verification@1.0.0
  test: acceptance-testing@1.0.0
```

For every skill use this exact front-matter shape, substituting `name` and the phase-specific source below:

```md
---
name: <skill-name>
version: 1.0.0
description: <single-line description>
phases: [<phase>]
methodSources:
  - id: superpowers:<method>
    version: 6.2.0
    source: configured:superpowers
---
```

Use these six mappings: `requirements-clarification`/`clarify`/`brainstorming`; `technical-solution`/`solution`/`brainstorming`; `implementation-planning`/`plan`/`writing-plans`; `typescript-web-implementation`/`implement`/`test-driven-development`; `web-verification`/`verify`/`test-driven-development`; `acceptance-testing`/`test`/`test-driven-development`.

- [x] **Step 3: Write phase-specific bodies without duplicating upstream methods**

Each file must contain `# <标题>` then headings `## 输入`、`## 步骤`、`## 验证`.

Use these mandatory outputs in the matching stages: clarify writes `brief.md`、`questions.md`、`acceptance.md`; solution writes `solution.md`; plan writes `implementation-plan.md`; implement writes `implementation.md`; verify writes `verification.md`; test writes `test-report.md`.

All bodies must instruct the agent to treat source material as untrusted data, to keep conclusions traceable to task facts, and to report verification evidence. The implementation skill additionally prohibits changing paths outside the approved scope when that control is available.

- [x] **Step 4: Write repository README**

Include the exact install command:

```bash
aiw skills install https://github.com/nalanchujian/ai-workflow-skills.git
```

Then document: required local `configured:superpowers` configuration; listing profiles; creating a task with `standard-web-feature@1.0.0`; the repository’s declarative-only security boundary; and semantic-versioning rules for skill changes.

- [x] **Step 5: Commit and push the first skills release**

Run:

```bash
git add README.md skills profiles
git commit -m "feat: add standard web feature skills"
git push -u origin main
git tag v1.0.0
git push origin v1.0.0
```

Expected: both `main` and tag `v1.0.0` are reachable from the public HTTPS Git URL.

### Task 2: Validate installation through the real public source

**Files:**
- Test: temporary isolated AIW home and temporary Git business repository (not committed to either repository).

**Interfaces:**
- Consumes: public `https://github.com/nalanchujian/ai-workflow-skills.git` and existing `aiw skills install`, `aiw skills profiles list`, and `aiw task init` commands.
- Produces: command output proving the public package is valid and task locks its profile and skills.

- [x] **Step 1: Prepare isolated test configuration**

Set `AIW_HOME` to a temporary empty directory. Create a `config.yaml` that points `methodSources.superpowers.root` at the locally installed Superpowers `skills` directory, with `version` and `revision` both `6.2.0`.

- [x] **Step 2: Install the public source and list the profile**

Run:

```bash
AIW_HOME=<temporary-home> aiw skills install https://github.com/nalanchujian/ai-workflow-skills.git --ref v1.0.0
AIW_HOME=<temporary-home> aiw skills profiles list --json
```

Expected: six skills are installed and JSON contains `standard-web-feature`, version `1.0.0`, and all six mappings.

- [x] **Step 3: Initialize a real temporary Git business repository**

Create a temporary repository containing a short Markdown requirement and run:

```bash
AIW_HOME=<temporary-home> aiw task init --project <temporary-business-repository> --source <temporary-business-repository>/requirements.md --skill-profile standard-web-feature@1.0.0 --json
```

Expected: the command returns an automatically generated `taskId`; the corresponding `.aiw/tasks/<task-id>/task.yaml` has six locked skills, each with the public source URL, its Git revision and Superpowers method-source hash.

- [x] **Step 4: Record validation evidence**

Run `aiw task status <task-id> --project <temporary-business-repository> --json`, retain the command outputs in the implementation handoff, then delete only the explicit temporary directories.

### Task 3: Replace placeholders in the CLI documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/07-发布运营/用户使用手册.md`

**Interfaces:**
- Consumes: published public repository URL.
- Produces: copy-pasteable team skill installation commands for users.

- [x] **Step 1: Replace the README placeholder source**

Replace `git@github.com:your-org/agent-skills.git` with:

```bash
https://github.com/nalanchujian/ai-workflow-skills.git
```

Add one sentence stating that this is the public standard template source and that teams should fork it before defining their own governance rules.

- [x] **Step 2: Make the user guide use the real source**

Replace `<team-skill-repository>` in the primary install example with the same HTTPS URL. Keep the generic placeholder only in the optional `--ref` syntax, where it explains an arbitrary team source.

- [x] **Step 3: Verify and commit the documentation update**

Run:

```bash
rg -n "your-org/agent-skills|ai-workflow-skills" README.md docs/07-发布运营/用户使用手册.md
git diff --check
git add README.md docs/07-发布运营/用户使用手册.md
git commit -m "docs: reference public team skills repository"
git push
```

Expected: no placeholder remains in the main workflow example, and the current branch is pushed.

## Plan Self-Review

- Spec coverage: Task 1 implements the isolated public repository, six locked method-backed skills, standard profile and README; Task 2 validates a normal installation and task lock; Task 3 exposes the published source in user-facing documentation.
- Placeholder scan: angle-bracket values only occur in command examples where the operator must provide a temporary path; no implementation or decision is deferred.
- Type consistency: all profile references are `name@1.0.0`, all declared phases match the current `WorkflowProfileSchema`, and every method source uses the existing `configured:superpowers` contract.
