"""Which job keywords a bullet already supports, for its rewrite to work in.

Handing every rewrite the job description's missing keywords is how a resume tool
invents experience: "Kubernetes" lands on a bullet about writing documentation.
So a keyword is only offered to a bullet whose own content already implies it,
and a rewrite that adds any other job keyword is flagged for the candidate.

A bullet supports a keyword when it
  - names it another way ("Postgres" for PostgreSQL, "k8s" for Kubernetes),
  - names something that entails it (Flask is Python, EKS is AWS, GitHub Actions
    is CI/CD), or
  - says the same thing in other words ("reviewed code" for code review). Only
    offered for plain lowercase terms, never a product name that's also an
    everyday word ("React", "Spark", "Segment").

A summary speaks for the whole resume, so for a summary line anything the rest of
the resume names counts too.

No model is involved: pure functions over strings, run on every analysis.
"""

from __future__ import annotations

import re

from job_fit import keyword_in, keyword_pattern

# names for the same thing. none is also an everyday word, so each one can be
# read as evidence for the others. spellings with capitals only match as written
# ("ML" is machine learning, "5 ml" isn't)
_SAME = [
    ("postgresql", "postgres", "psql"),
    ("kubernetes", "k8s"),
    ("javascript", "JS", "ecmascript"),
    ("aws", "amazon web services"),
    ("gcp", "google cloud", "google cloud platform"),
    ("azure", "microsoft azure"),
    ("machine learning", "ML"),
    ("artificial intelligence", "AI"),
    ("natural language processing", "nlp"),
    ("large language models", "large language model", "llms", "llm"),
    ("user experience", "UX"),
    ("user interface", "UI"),
    ("node.js", "nodejs"),
    ("vue", "vue.js", "vuejs"),
    ("next.js", "nextjs"),
    ("c#", "csharp"),
    (".net", "dotnet"),
    ("rest api", "rest apis", "restful api", "restful apis", "restful"),
    ("mongodb", "mongo"),
    ("scikit-learn", "sklearn"),
    ("infrastructure as code", "iac"),
    ("test-driven development", "test driven development", "TDD"),
    ("object-oriented programming", "object oriented programming", "OOP"),
    ("a/b testing", "a/b tests", "a/b test", "a/b tested"),
    ("power bi", "powerbi"),
    ("sql server", "microsoft sql server", "mssql"),
]

_ALIASES: dict[str, tuple[str, ...]] = {
    form.lower(): tuple(other for other in group if other != form)
    for group in _SAME for form in group
}
# one way only: the job's spelling is an everyday word ("go", "node", "rest"), or
# the evidence covers only part of what the keyword claims (CI isn't CD)
_ALIASES.update({
    "go": ("golang",),
    "node": ("node.js", "nodejs"),
    "rest": ("restful", "rest api", "rest apis"),
    "ci/cd": ("CI", "continuous integration", "continuous delivery", "continuous deployment"),
    "continuous integration": ("CI",),
})

# what a named tool entails. evidence with capitals must match as written, so
# "Flask" counts and a lab's "flask" doesn't
_IMPLIED_BY: dict[str, tuple[str, ...]] = {
    "python": ("Flask", "django", "fastapi", "pandas", "numpy", "scipy", "pytest", "scikit-learn", "sklearn",
               "pytorch", "keras", "jupyter", "pyspark", "sqlalchemy", "pydantic", "matplotlib", "seaborn",
               "streamlit", "boto3"),
    "javascript": ("typescript", "React", "react.js", "reactjs", "Vue", "vue.js", "vuejs", "Angular", "angularjs",
                   "node.js", "nodejs", "express.js", "expressjs", "next.js", "nextjs", "jquery", "svelte",
                   "Jest", "webpack"),
    "java": ("spring boot", "Hibernate", "junit", "Maven"),
    "c#": (".net", "asp.net", "entity framework", "blazor", "xamarin"),
    ".net": ("asp.net", "entity framework", "blazor", "c#"),
    "ruby": ("ruby on rails", "Rails", "rspec"),
    "php": ("laravel", "symfony"),
    "sql": ("postgresql", "postgres", "mysql", "sqlite", "sql server", "mssql", "t-sql", "pl/sql", "mariadb",
            "bigquery", "Snowflake"),
    "nosql": ("mongodb", "mongo", "dynamodb", "couchdb", "couchbase", "firestore", "redis", "neo4j"),
    "databases": ("postgresql", "postgres", "mysql", "sqlite", "sql server", "mongodb", "dynamodb", "redis",
                  "mariadb", "firestore"),
    "aws": ("ec2", "s3", "eks", "ecs", "rds", "dynamodb", "cloudformation", "sqs", "cloudwatch", "sagemaker",
            "fargate", "kinesis", "aws lambda", "elastic beanstalk", "cloudfront", "route 53", "Redshift"),
    "gcp": ("bigquery", "gke", "cloud run", "app engine", "vertex ai", "bigtable", "dataproc", "cloud sql",
            "pub/sub", "firestore"),
    "azure": ("aks", "cosmos db", "cosmosdb"),
    "cloud": ("aws", "gcp", "azure", "google cloud", "ec2", "s3", "eks", "gke", "aks", "heroku", "cloud run"),
    "kubernetes": ("eks", "gke", "aks", "kubectl", "openshift", "argo cd", "argocd", "kustomize", "Helm"),
    "docker": ("dockerfile", "dockerfiles", "docker-compose"),
    "containers": ("docker", "kubernetes", "k8s", "eks", "ecs", "gke", "aks", "podman", "openshift"),
    "ci/cd": ("github actions", "jenkins", "circleci", "gitlab ci", "travis ci", "azure pipelines", "argo cd",
              "argocd", "teamcity", "buildkite", "bitbucket pipelines", "spinnaker"),
    "continuous integration": ("github actions", "jenkins", "circleci", "gitlab ci", "travis ci", "teamcity",
                               "buildkite"),
    "infrastructure as code": ("terraform", "cloudformation", "pulumi", "ansible", "aws cdk"),
    "observability": ("Prometheus", "grafana", "datadog", "new relic", "opentelemetry", "Honeycomb", "zipkin",
                      "distributed tracing", "splunk", "kibana", "elk stack"),
    "monitoring": ("Prometheus", "grafana", "datadog", "new relic", "opentelemetry", "cloudwatch", "nagios",
                   "zabbix", "pagerduty", "splunk", "Sentry"),
    "message queues": ("kafka", "rabbitmq", "sqs", "pub/sub", "activemq", "zeromq", "service bus", "kinesis"),
    "event-driven": ("kafka", "kinesis", "pub/sub", "rabbitmq", "eventbridge"),
    "streaming": ("kafka", "kinesis", "flink", "spark streaming"),
    "machine learning": ("scikit-learn", "sklearn", "pytorch", "tensorflow", "keras", "xgboost", "lightgbm",
                         "neural network", "neural networks", "random forest", "gradient boosting", "deep learning",
                         "hugging face", "huggingface"),
    "deep learning": ("pytorch", "tensorflow", "keras", "neural network", "neural networks", "cnn", "cnns",
                      "lstm", "bert"),
    "data analysis": ("pandas", "exploratory data analysis"),
    "data visualization": ("tableau", "power bi", "matplotlib", "seaborn", "plotly", "d3.js", "ggplot2"),
    "etl": ("dbt", "fivetran", "aws glue", "informatica", "talend", "ssis"),
    "data pipelines": ("Airflow", "dbt", "pyspark", "fivetran", "aws glue", "dagster", "apache beam", "Spark"),
    "big data": ("hadoop", "pyspark", "databricks", "Spark"),
    "agile": ("scrum", "kanban", "sprint planning", "sprints", "standups", "stand-ups", "retrospectives"),
    "testing": ("pytest", "Jest", "junit", "Cypress", "Selenium", "Playwright", "rspec", "vitest", "testng",
                "xunit", "nunit"),
    "test automation": ("Cypress", "Selenium", "Playwright", "pytest", "Jest", "junit", "testng", "appium"),
    "unit testing": ("pytest", "Jest", "junit", "rspec", "vitest", "xunit", "nunit", "unit tests"),
    "git": ("github", "gitlab", "bitbucket", "pull requests", "pull request", "merge requests"),
    "version control": ("git", "github", "gitlab", "bitbucket", "pull requests", "pull request", "subversion",
                        "mercurial"),
    "linux": ("ubuntu", "debian", "centos", "rhel", "Fedora"),
    "shell scripting": ("Bash", "zsh", "powershell"),
    "frontend": ("React", "Vue", "vue.js", "Angular", "angularjs", "svelte", "next.js", "css", "html",
                 "tailwind", "redux"),
    "backend": ("Flask", "django", "fastapi", "express.js", "spring boot", "ruby on rails", "laravel", "node.js",
                "nodejs"),
    "ios": ("swiftui", "uikit", "xcode", "objective-c"),
    "mobile": ("react native", "swiftui", "jetpack compose", "Flutter", "ios", "android"),
    "api": ("restful", "REST", "graphql", "grpc", "openapi", "swagger"),
    "leadership": ("led", "Led", "supervised", "managed a team"),
    "mentoring": ("mentored", "coached"),
    "communication": ("presented",),
    "excel": ("vlookup", "xlookup", "pivot tables", "pivot table", "power query"),
    "experimentation": ("a/b test", "a/b tests", "a/b testing", "a/b tested"),
    "authentication": ("oauth", "oauth2", "jwt", "saml", "openid connect"),
}
# other ways the job side words the same entries
for _alias, _key in (
    ("database", "databases"), ("google cloud", "gcp"), ("amazon web services", "aws"), ("k8s", "kubernetes"),
    ("containerization", "containers"), ("containerisation", "containers"), ("containerized", "containers"),
    ("message queue", "message queues"), ("messaging", "message queues"), ("message brokers", "message queues"),
    ("event streaming", "streaming"), ("data streaming", "streaming"), ("ml", "machine learning"),
    ("data visualisation", "data visualization"), ("data engineering", "data pipelines"),
    ("data pipeline", "data pipelines"), ("automated testing", "test automation"),
    ("software testing", "testing"), ("front-end", "frontend"), ("front end", "frontend"),
    ("back-end", "backend"), ("back end", "backend"), ("apis", "api"), ("mentorship", "mentoring"),
    ("microsoft excel", "excel"), ("team leadership", "leadership"),
):
    _IMPLIED_BY.setdefault(_alias, _IMPLIED_BY[_key])

# lowercase evidence that still has to match as written: "LED" isn't "led"
_EXACT_CASE = {"led", "dbt"}

# words the job side wraps a term in. dropped only to look the term up in the
# tables above, which are curated, so "Python programming" finds Python
_WRAPPERS = {
    "experience", "knowledge", "proficiency", "skills", "skill", "familiarity", "expertise", "programming",
    "language", "languages", "platform", "platforms", "services", "computing", "development", "framework",
    "frameworks", "tools", "tooling", "technologies", "technology", "architecture", "infrastructure",
    "concepts", "principles", "fundamentals", "with", "using", "in",
}

# product names that are also everyday words, never matched by their word forms
_WORDLIKE_NAMES = {
    "react", "go", "swift", "rust", "spark", "express", "excel", "rails", "spring", "slack", "render", "notion",
    "pandas", "unity", "vault", "puppet", "torch", "remix", "ember", "backbone", "sketch", "flutter", "electron",
    "jest", "chef", "salt", "hive", "beam", "storm", "glue", "lambda", "snowflake", "redshift", "access", "word",
    "teams", "project", "office", "segment", "harness", "make", "flux", "maven", "ant", "poetry", "logic",
    "stripe", "square", "heap", "amplitude", "delta", "iceberg", "presto", "druid", "envoy", "nomad", "consul",
    "helm", "argo", "airflow", "looker", "docker", "packer", "mode", "dash", "ray", "polars", "prefect",
    "cypress", "selenium", "playwright", "mocha", "angular", "ionic", "dart", "julia", "elm", "crystal",
    "linear", "premiere", "outlook", "publisher", "confluence", "vagrant", "safari", "chrome",
}

_STOPWORDS = {"a", "an", "and", "or", "of", "the", "to", "in", "on", "for", "with", "at", "by", "from", "as", "via", "&"}

_TOKEN_RE = re.compile(r"[a-z0-9+#][a-z0-9+#/.]*")

# an acronym and its plural are the same keyword: API and APIs
_ACRONYM_RE = re.compile(r'^[A-Z]{3,6}s?$')

# (suffix, the shortest stem it may leave). "documents" isn't "docu" + "ments"
_SUFFIXES = (
    ("isations", 3), ("isation", 3), ("ations", 3), ("ation", 3), ("ions", 3), ("ion", 3),
    ("ments", 5), ("ment", 5), ("ibility", 3), ("ability", 3), ("ible", 3), ("able", 3), ("ship", 4),
    ("ings", 3), ("ing", 3), ("ies", 2), ("ied", 2), ("es", 3), ("ed", 3), ("s", 3),
)


def _norm(term: str) -> str:
    return " ".join((term or "").lower().split())


def _lookup_keys(keyword: str) -> list[str]:
    """The keyword and its wrapper-free core, in the spellings the tables use."""
    key = _norm(keyword)
    keys = [key]
    core = " ".join(word for word in key.split() if word not in _WRAPPERS)
    if core and core != key:
        keys.append(core)
    for k in list(keys):
        for variant in (k.replace("-", " "), k.replace(" ", "-"), k.replace("-", "")):
            if variant not in keys:
                keys.append(variant)
    return keys


def _find(term: str, text: str) -> str:
    """``term`` as it's written in ``text``, or "". Terms with capitals, and a few
    lowercase ones, only match exactly as written."""
    if term != term.lower() or term in _EXACT_CASE:
        match = re.search(r'(?<![A-Za-z0-9])' + re.escape(term) + r'(?![A-Za-z0-9+#])', text)
        return match.group(0) if match else ""
    lower = text.lower()
    match = keyword_pattern(term).search(lower)
    if not match:
        return ""
    return text[match.start():match.end()] if len(lower) == len(text) else match.group(0)


def _stems(word: str) -> set[str]:
    """Every plausible stem of one word. Loose on purpose: a keyword only counts as
    reworded when every one of its words matches one of these."""
    word = word.strip("./").replace("yz", "ys").replace("iz", "is")
    if word.endswith("ysis"):
        word = word[:-2]
    bases = {word}
    for suffix, shortest in _SUFFIXES:
        if suffix == "s" and word.endswith("ss"):
            continue
        if word.endswith(suffix) and len(word) - len(suffix) >= shortest:
            base = word[:-len(suffix)]
            bases.add(base + "y" if suffix in ("ies", "ied") else base)
    stems = set()
    for base in bases:
        stems.add(base)
        stems.add(base[:-1] if base.endswith("e") else base + "e")
        if len(base) > 3 and base[-1] == base[-2] and base[-1] not in "aeious":
            stems.add(base[:-1])
    return stems


def _reworded(keyword: str, text: str, strict: bool) -> str:
    """The text's own words for ``keyword``, or "".

    Strict, for offering a keyword, only plain lowercase keywords qualify: a
    capitalised one may be a product ("Sketch" isn't "sketched"). Checking a
    rewrite is lenient, so "Code Review" for "reviewed code" isn't flagged.
    """
    if strict and keyword != keyword.lower():
        return ""
    words = [w for w in _TOKEN_RE.findall(_norm(keyword).replace("-", " ")) if w not in _STOPWORDS]
    # a lone word may be a product ("Segment"), a phrase ("project management") isn't
    if not words or (len(words) == 1 and (words[0] in _WORDLIKE_NAMES or len(words[0]) < 5)):
        return ""
    tokens = [(token, _stems(token)) for token in _TOKEN_RE.findall(text.lower().replace("-", " "))]
    matched = set()
    for word in words:
        wanted = _stems(word)
        hit = next((token for token, stems in tokens if stems & wanted), None)
        if hit is None:
            return ""
        matched.add(hit)
    # the text's words in its own order, for showing the candidate
    return " ".join(dict.fromkeys(token for token, _stems_ in tokens if token in matched))


def support(keyword: str, text: str, resume_text: str = "", strict: bool = True) -> dict | None:
    """How ``text`` supports ``keyword``: {"via", "evidence"}, or None.

    ``via`` is "alias", "implied" or "reworded" for evidence in the text itself,
    or "resume" when ``resume_text`` is given (a summary line) and the rest of
    the resume names it. Whether the text states the keyword outright is the
    caller's question, not this one's.
    """
    keys = _lookup_keys(keyword)
    if _ACRONYM_RE.match(keyword.strip()):
        stripped = keyword.strip()
        other = stripped[:-1] if stripped.endswith("s") else stripped + "s"
        found = _find(other, text)
        if found:
            return {"via": "alias", "evidence": found}
    for key in keys:
        for form in _ALIASES.get(key, ()):
            found = _find(form, text)
            if found:
                return {"via": "alias", "evidence": found}
    for key in keys:
        for term in _IMPLIED_BY.get(key, ()):
            found = _find(term, text)
            if found:
                return {"via": "implied", "evidence": found}
    words = _reworded(keyword, text, strict)
    if words:
        return {"via": "reworded", "evidence": words}
    if resume_text:
        if keyword_in(keyword, resume_text.lower()):
            return {"via": "resume", "evidence": keyword}
        # a named tool elsewhere on the resume, not a loose word match
        for key in keys:
            for term in (*_ALIASES.get(key, ()), *_IMPLIED_BY.get(key, ())):
                found = _find(term, resume_text)
                if found:
                    return {"via": "resume", "evidence": found}
    return None


def plan(
    bullets: list[tuple[str, str]],
    keywords: list[str],
    resume_text: str = "",
    per_bullet: int = 2,
    per_keyword: int = 2,
) -> dict[str, list[dict]]:
    """The job keywords each bullet may work in, keyed by bullet text.

    ``bullets`` are (text, section) pairs in resume order. Keywords the resume is
    missing come first, since those are the ones that move the match. Each bullet
    gets at most ``per_bullet``, and each keyword goes to at most ``per_keyword``
    bullets, so it lands where it's supported instead of in every line.
    """
    resume_lower = (resume_text or "").lower()
    ranked = sorted(range(len(keywords)), key=lambda i: (keyword_in(keywords[i], resume_lower), i))
    given: dict[str, int] = {}
    offers: dict[str, list[dict]] = {}
    for text, section in bullets:
        if text in offers:
            continue
        lower = text.lower()
        context = resume_text if section == "SUMMARY" else ""
        picked: list[dict] = []
        for i in ranked:
            if len(picked) >= per_bullet:
                break
            keyword = keywords[i]
            key = _norm(keyword)
            if given.get(key, 0) >= per_keyword or keyword_in(keyword, lower):
                continue
            found = support(keyword, text, context)
            if found:
                picked.append({"keyword": keyword, **found})
                given[key] = given.get(key, 0) + 1
        if picked:
            offers[text] = picked
    return offers


def check(original: str, rewritten: str, keywords: list[str], resume_text: str = "") -> dict:
    """What a rewrite did with the job's keywords.

    ``keywords_added`` are the ones it worked in that the original supports, with
    the evidence. ``unsupported_keywords`` are ones it added that the original
    doesn't, which the candidate is asked to check before accepting.
    """
    before, after = (original or "").lower(), (rewritten or "").lower()
    added, unsupported = [], []
    for keyword in keywords:
        if keyword_in(keyword, before) or not keyword_in(keyword, after):
            continue
        found = support(keyword, original, resume_text, strict=False)
        if found:
            added.append({"keyword": keyword, **found})
        else:
            unsupported.append(keyword)
    out: dict = {}
    if added:
        out["keywords_added"] = added
    if unsupported:
        out["unsupported_keywords"] = unsupported
    return out
