cmake_minimum_required(VERSION 2.8.12...3.29)

project(HTTPFsExtension)

add_extension_definitions()

if (NOT EMSCRIPTEN)
  add_definitions(-DOVERRIDE_ENCRYPTION_UTILS=1)
else()
  set(DUCKDB_EXTENSION_HTTPFS_LINKED_LIBS "../../third_party/mbedtls/libduckdb_mbedtls.a")
endif()

if(MINGW)
  set(OPENSSL_USE_STATIC_LIBS TRUE)
endif()

# OpenSSL is available for every target (vcpkg also provides a wasm32-emscripten
# build): crypto.hpp includes <openssl/rand.h> even under EMSCRIPTEN, so its
# headers must always be on the include path.
find_package(OpenSSL REQUIRED)
include_directories(${OPENSSL_INCLUDE_DIR})
if(NOT EMSCRIPTEN)
  find_package(CURL REQUIRED)
  include_directories(${CURL_INCLUDE_DIRS})
endif()

include_directories(src/include
                    ${DUCKDB_MODULE_BASE_DIR}/third_party/httplib)
add_subdirectory(src)
set(EXTENSION_SOURCES ${ALL_OBJECT_FILES})

build_static_extension(httpfs ${EXTENSION_SOURCES})

set(PARAMETERS "-warnings")
build_loadable_extension(httpfs ${PARAMETERS} ${EXTENSION_SOURCES})

if(EMSCRIPTEN)
  target_link_libraries(httpfs_loadable_extension duckdb_mbedtls)
else()
  # Link dependencies into extension
  target_link_libraries(httpfs_loadable_extension ${CURL_LIBRARIES})
  target_link_libraries(httpfs_extension ${CURL_LIBRARIES})

  target_link_libraries(httpfs_loadable_extension duckdb_mbedtls
                        ${OPENSSL_LIBRARIES})
  target_link_libraries(httpfs_extension duckdb_mbedtls ${OPENSSL_LIBRARIES})

  if(MINGW)
    find_package(ZLIB)
    target_link_libraries(httpfs_loadable_extension ZLIB::ZLIB -lcrypt32)
    target_link_libraries(httpfs_extension ZLIB::ZLIB -lcrypt32)
  endif()
endif()


install(
  TARGETS httpfs_extension
  EXPORT "${DUCKDB_EXPORT_SET}"
  LIBRARY DESTINATION "${INSTALL_LIB_DIR}"
  ARCHIVE DESTINATION "${INSTALL_LIB_DIR}")
