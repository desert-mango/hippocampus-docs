# Releasing Debian Packages


<div class="adm adm-note"><p class="adm-title">Note</p>

This section is targeted at the maintainers of our repositories and is not relevant for anyone else.



</div>

## Create a new Release for an Existing Package


The basic steps are


1. generate a changelog

2. bump the package version

3. create and push a new tag for that version


After that the [buildbot](https://buildbot.hippocampus-robotics.net) will try to generate a new debian package and will update the [HippoCampus Repository](https://repositories.hippocampus-robotics.net/).


There are convenience tools to perform the above mentioned steps, so the commands we need to exectute are the following:


```console
$ cd <REPOSITORY>
```

```console
$ catkin_generate_changelog \
&& git add CHANGELOG.rst \
&& git commit -m 'updated changelog' \
&& catkin_prepare_release
```

That's it!


## Create a Release for a new Package


This requires some additional steps as it involves updating the buildbot to make sure it builds the release.


1. Add the new package to the list of repositories in the [master.cfg](https://github.com/HippoCampusRobotics/buildbot/blob/main/basedir/master.cfg) in the [buildbot](https://github.com/HippoCampusRobotics/buildbot) repository.


    <div class="adm adm-note"><p class="adm-title">Note</p>

    Currently only repositories directly representing a ros package are supported. Support for multiple packages per repository could be enabled by updating the buildbot config to handle these cases.



    </div>

2. Restart the buildbot instace on the buildbot server


    ```console
    $ buildbot restart basedir
    ```

    <div class="adm adm-note"><p class="adm-title">Note</p>

    If there are currently builds being processed, the buildbot master will not exit before they are completed. In this case, we will get the message


    ```console
    $ buildbot restart basedir
    never saw process go away
    ```

    We can either wait until it has completed (probably preferable) or if we do not care about the running builds, kill the `twistd` process.



    </div>

3. Add the key for the package to our [rosdep file](https://github.com/HippoCampusRobotics/hippo_infrastructure/blob/main/rosdep-jazzy.yaml) in our [infrastructure repository](https://github.com/HippoCampusRobotics/hippo_infrastructure) (otherwise `rosdep` will not be able to resolve dependencies on the new repository).

4. Now execute the same steps as for [existing packages](#/setup/contributing/debian-packages@create-a-new-release-for-an-existing-package). The only difference is to append `--all` to the `catkin_generate_changelog` command so it becomes


    ```console
    $ catkin_generate_changelog --all
    ```



<p class="provenance">Migrated from the previous docs site: <a href="https://hippocampusrobotics.github.io/docs/contents/contributing/releasing_debian_packages.html">contents/contributing/releasing_debian_packages</a>.</p>
