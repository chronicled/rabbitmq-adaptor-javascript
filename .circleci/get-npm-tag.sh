#!/bin/sh
case $CIRCLE_BRANCH in
  "develop")
    NPM_TAG='alpha'
    NPM_VERSION_STEP='prerelease'
    ;;
  "master")
    NPM_TAG='latest'
    NPM_VERSION_STEP='patch'
    ;;
esac

if [ -z $NPM_TAG ];then
  echo "No NPM Tag set for current branch" 1>&2
  exit 1;
fi

echo "$NPM_TAG $NPM_VERSION_STEP"