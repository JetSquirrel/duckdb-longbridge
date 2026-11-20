# Trading-lab build: longbridge plus jev and httpfs, for the demo web app and
# the native lab shell. Select it with
#   make debug EXT_CONFIG=$PWD/extension_config_lab.cmake

duckdb_extension_load(longbridge
    SOURCE_DIR ${CMAKE_CURRENT_LIST_DIR}
)

# Jev AI decision extension (vendored from colliber/duckdb-jev, patched for HTTPUtil/wasm)
duckdb_extension_load(jev
    SOURCE_DIR ${CMAKE_CURRENT_LIST_DIR}/jev
)

# httpfs: native DuckDB-core's built-in HTTP client cannot POST; jev needs a
# POST-capable HTTPUtil, which httpfs installs when loaded
duckdb_extension_load(httpfs
    SOURCE_DIR ${CMAKE_CURRENT_LIST_DIR}/httpfs
)
