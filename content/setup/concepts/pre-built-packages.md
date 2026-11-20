# Pre-built Packages


## Why do I need Pre-built Packages?


Simple answer: you don't. It's mere convenience to be able to install packages we would like to use via a simple `apt install` command. Alternatively, we would need to clone the source code of the packages we would like to use and build them ourselves.


## When **not** to install Pre-built Packages?


If you want to modify certain packages to your needs, you want to have the source code inside your workspace(s). Pre-built packages and the installatio from source are not mutually exclusive. This means, it is perfectly fine to install all the packages from pre-built binaries and *overlay* them with the modified built-from-source version in your workspace. The last sourced version of a package takes precedence over all prior versions.


<div class="adm adm-hint"><p class="adm-title">Hint</p>

This also implies if you want to work with the pre-built version of a package, make sure you do not have a local version in one of your sourced workspaces. Deleting the source files is not sufficient, you need to remove the corresponding files/directories in the `install` directory inside your workspace as well.



</div>

## Which Packages can I Install via `apt`?


To find out which packages can be installed from our repository for the machine you are on, execute

```console
$ curl -s https://repositories.hippocampus-robotics.net/ubuntu/dists/noble/main/binary-$(dpkg --print-architecture)/Packages \
| grep "^Package: " \
| cut -d" " -f2 | sort -u
```

`$(dpkg --print-architecture)` is `amd64` on a desktop computer and `arm64` on a Raspberry Pi. The two lists are not the same. On 2026-09-16 the `amd64` list read:

```console
ros-jazzy-acoustic-msgs
ros-jazzy-alpha-msgs
ros-jazzy-buttons-msgs
ros-jazzy-dvl
ros-jazzy-dvl-msgs
ros-jazzy-esc
ros-jazzy-gantry
ros-jazzy-gantry-gui
ros-jazzy-gantry-msgs
ros-jazzy-hardware
ros-jazzy-hippo-common
ros-jazzy-hippo-common-msgs
ros-jazzy-hippo-control
ros-jazzy-hippo-control-msgs
ros-jazzy-hippo-full
ros-jazzy-hippo-gz-plugins
ros-jazzy-hippo-msgs
ros-jazzy-hippo-robot
ros-jazzy-hippo-sim
ros-jazzy-mjpeg-cam
ros-jazzy-path-planning
ros-jazzy-px4-msgs
ros-jazzy-qualisys-bridge
ros-jazzy-rapid-trajectories-msgs
ros-jazzy-remote-control
ros-jazzy-state-estimation-msgs
ros-jazzy-uvms-msgs
ros-jazzy-visual-localization
```

The `arm64` list had the same packages except `ros-jazzy-acoustic-msgs`. Because `ros-jazzy-hippo-robot` depends on it, `hippo_robot` cannot be installed on a Raspberry Pi until an `arm64` build of `acoustic_msgs` is published; install the packages you need one by one instead. The list changes over time, so run the command rather than trusting this copy.

We can install them by


```console
$ sudo apt install ros-${ROS_DISTRO}-<PACKAGE_NAME>
```

for example, if we want to install the remote control package the command would be


```console
$ sudo apt install ros-${ROS_DISTRO}-remote-control
```

<div class="adm adm-tip"><p class="adm-title">Tip</p>

There are meta-packages such as (not necessarily limited to) `hippo_full`, `hippo_robot` or `hippo_common_msgs`. They do not contain any source code, but depend on other packages to make the installation of bundles of packages more convenient. For example, `hippo_full` depends on (almost) all our message packages and all the other `ros2` packages we provide. This way, instead of installing all these packages one by one, the installation just boils down to


```console
$ sudo apt install ros-jazzy-hippo-full
```

and all the dependencies get installed automatically.



</div>


<p class="provenance">Migrated from the previous docs site: <a href="https://hippocampusrobotics.github.io/docs/contents/concepts/pre-built_packages.html">contents/concepts/pre-built_packages</a>.</p>
