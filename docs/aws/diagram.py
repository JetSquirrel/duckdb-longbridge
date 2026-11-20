# DuckDB Trading Lab — AWS deployment architecture (ap-east-1, as deployed).
# Standard AWS icon set via mingrammer/diagrams (https://diagrams.mingrammer.com/).
# Run: .cache/diagrams-venv/bin/python docs/aws/diagram.py
# Requires graphviz (`brew install graphviz`) for the `dot` renderer.

from pathlib import Path

from diagrams import Cluster, Diagram, Edge
from diagrams.aws.compute import ECR, Lambda
from diagrams.aws.mobile import Amplify
from diagrams.custom import Custom
from diagrams.onprem.client import Client, Users

ICONS = Path(__file__).parent / "icons"

GRAPH_ATTR = {
    "fontsize": "15",
    "bgcolor": "white",
    "pad": "0.4",
    "splines": "spline",
    "nodesep": "0.8",
    "ranksep": "1.2",
    "newrank": "true",
}

DASHED = {"style": "dashed", "color": "#879196", "fontcolor": "#545B64"}

with Diagram(
    "\nDuckDB Trading Lab on AWS (ap-east-1)",
    filename="docs/aws/architecture-aws-icons",
    show=False,
    direction="LR",
    outformat="png",
    graph_attr=GRAPH_ATTR,
):
    user = Users("User")

    with Cluster("Browser",
                 graph_attr={"style": "rounded", "bgcolor": "#F2F4F8", "fontcolor": "#16191F"}):
        spa = Client("React SPA\n+ DuckDB-WASM")

    with Cluster("AWS Cloud · ap-east-1",
                 graph_attr={"style": "rounded,dashed", "color": "#00A1C9", "fontcolor": "#00A1C9", "bgcolor": "#F6FBFD"}):
        web = Amplify("Amplify Hosting")
        fn = Lambda("Lambda Function URL\ncontainer image")
        ecr = ECR("ECR\ngateway image")
        ecr >> Edge(**DASHED) >> fn

    with Cluster("External",
                 graph_attr={"style": "rounded,dashed", "color": "#879196", "fontcolor": "#545B64"}):
        lp = Custom("LongPort OpenAPI", str(ICONS / "longport.png"))
        ts = Custom("TypeSafe Jev API", str(ICONS / "typesafe.png"))

    user >> spa
    spa >> Edge(label="1 page + .wasm", color="#16191F", fontcolor="#16191F", penwidth="1.6") >> web
    spa >> Edge(label="2 /v1/* /jev/*", color="#16191F", fontcolor="#16191F", penwidth="1.6") >> fn
    fn >> Edge(label="live quotes", **DASHED) >> lp
    fn >> Edge(label="with API key", **DASHED) >> ts
