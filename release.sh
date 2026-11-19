# docker build -t hcf-app ../build.sh
# docker tag hcf-app "${DOCKER_ORGANIZATION_NAME}"/hcf-app:"${CI_COMMIT_REF_NAME}"
# docker login -u "${DOCKER_USERNAME}" -p "${DOCKER_PASSWORD}" docker.io
# docker push "${DOCKER_ORGANIZATION_NAME}"/hcf-app:"${CI_COMMIT_REF_NAME}"

sudo docker-compose up --build