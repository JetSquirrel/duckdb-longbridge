# This file is included by DuckDB's build system. It specifies which extension to load.
#
# Only the longbridge extension: this is what DuckDB's community-extensions CI
# and MainDistributionPipeline build. The trading-lab build that also bundles
# jev and httpfs is extension_config_lab.cmake (see README "Build").

duckdb_extension_load(longbridge
    SOURCE_DIR ${CMAKE_CURRENT_LIST_DIR}
)
