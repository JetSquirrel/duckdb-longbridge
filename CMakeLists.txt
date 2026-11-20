cmake_minimum_required(VERSION 3.5)

# Set extension name here
set(TARGET_NAME longbridge)

# DuckDB's extension distribution supports vcpkg. As such, dependencies can be
# added in ./vcpkg.json and then used in cmake with find_package. Feel free to
# remove or replace with other dependencies. Note that it should also be removed
# from vcpkg.json to prevent needlessly installing it..
find_package(OpenSSL REQUIRED)

set(EXTENSION_NAME ${TARGET_NAME}_extension)
set(LOADABLE_EXTENSION_NAME ${TARGET_NAME}_loadable_extension)

project(${TARGET_NAME})

set(CMAKE_CXX_STANDARD
    "17"
    CACHE STRING "C++ standard to enforce")
set(CMAKE_CXX_STANDARD_REQUIRED ON)

include_directories(src/include)

# Under Emscripten the loadable target is a static archive; the actual wasm side
# module link happens in the emcc POST_BUILD step, which only receives
# DUCKDB_EXTENSION_<NAME>_LINKED_LIBS. HMAC/EVP symbols would otherwise stay
# undefined (duckdb-wasm's main module links mbedtls, not OpenSSL).
if(EMSCRIPTEN)
  set(DUCKDB_EXTENSION_LONGBRIDGE_LINKED_LIBS
      "$<TARGET_FILE:OpenSSL::SSL> $<TARGET_FILE:OpenSSL::Crypto>")
endif()

set(EXTENSION_SOURCES
    src/longbridge_extension.cpp src/longbridge_client.cpp
    src/functions/quote.cpp src/functions/instruments.cpp
    src/functions/bars.cpp src/functions/portfolio.cpp)

build_static_extension(${TARGET_NAME} ${EXTENSION_SOURCES})
build_loadable_extension(${TARGET_NAME} " " ${EXTENSION_SOURCES})

# Link OpenSSL in both the static library as the loadable extension
target_link_libraries(${EXTENSION_NAME} OpenSSL::SSL OpenSSL::Crypto)
target_link_libraries(${LOADABLE_EXTENSION_NAME} OpenSSL::SSL OpenSSL::Crypto)

install(
  TARGETS ${EXTENSION_NAME}
  EXPORT "${DUCKDB_EXPORT_SET}"
  LIBRARY DESTINATION "${INSTALL_LIB_DIR}"
  ARCHIVE DESTINATION "${INSTALL_LIB_DIR}")
