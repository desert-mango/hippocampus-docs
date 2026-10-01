# ROS Installation


<div class="adm adm-attention"><p class="adm-title">Attention</p>

We are moving to ROS2. This guide and the following pages are still in the process of being updated. There might be some construction works still going on here and there.



</div>

<div class="adm adm-note"><p class="adm-title">Note</p>

This guide assumes [Ubuntu 24.04](https://releases.ubuntu.com/24.04/) is used as OS.




</div>

We use ROS2 Jazzy. The following installations steps work for a Ubuntu 24.04 amd64 version **and** for the Ubuntu 24.04 arm64 server image for the Raspberry Pi.


## Preparation


1. Make sure you have a UTF-8 supported locale with


    ```console
    $ locale
    ```

    If not, refer to the [ROS documentation](https://docs.ros.org/en/jazzy/Installation/Ubuntu-Install-Debians.html#set-locale).


2. Enable universe repository


    ```console
    $ sudo apt install software-properties-common \
    && sudo add-apt-repository universe
    ```

3. Add the ROS 2 apt source

    Install the official `ros2-apt-source` package. It brings both the ROS signing key and the apt source, and it keeps them up to date.

    ```console
    $ sudo apt update && sudo apt install curl -y \
    && export ROS_APT_SOURCE_VERSION=$(curl -s https://api.github.com/repos/ros-infrastructure/ros-apt-source/releases/latest | grep -F "tag_name" | awk -F\" '{print $4}') \
    && curl -L -o /tmp/ros2-apt-source.deb "https://github.com/ros-infrastructure/ros-apt-source/releases/download/${ROS_APT_SOURCE_VERSION}/ros2-apt-source_${ROS_APT_SOURCE_VERSION}.$(. /etc/os-release && echo $UBUNTU_CODENAME)_all.deb" \
    && sudo dpkg -i /tmp/ros2-apt-source.deb
    ```

4. Check the source

    ```console
    $ ls -l /etc/apt/sources.list.d/ros2.sources
    ```

    It should be a symbolic link to `/usr/share/ros-apt-source/ros2.sources`. If an older guide left a `/etc/apt/sources.list.d/ros2.list` behind, remove that file so the repository is not configured twice.

5. Update


    <div class="adm adm-warning"><p class="adm-title">Warning</p>

    This is critial!



    </div>

    ```console
    $ sudo apt update && sudo apt upgrade -y
    ```


## Installation


Choose the installation option depending on your needs, e.g. use a more lightweight installation for Raspberry Pis.


1. Install ROS


    <div class="tabs">

    <div class="tab" data-label="desktop-full">

    ```sh
    sudo apt install ros-jazzy-desktop-full
    ```

    </div>

    <div class="tab" data-label="perception (e.g. for Raspberry Pi)">

    ```sh
    sudo apt install ros-jazzy-perception
    ```

    </div>


    </div>

2. Install development tools


    ```console
    $ sudo apt install ros-dev-tools python3-pip
    ```


## rosdep Initialization


```console
$ sudo rosdep init && rosdep update
```

<div class="adm adm-note"><p class="adm-title">Note</p>

Do **not** execute `rosdep update` with root privileges. This would lead to permission issues.



</div>

## Source the ROS Setup


```console
$ echo 'source /opt/ros/jazzy/setup.zsh' >> ~/.zshrc \
&& . ~/.zshrc
```

## A Brief Test (Optional)


To check whether ROS2 installation is working:


```console
$ ros2 run turtlesim turtlesim_node
```


<p class="provenance">Migrated from the previous docs site: <a href="https://hippocampusrobotics.github.io/docs/contents/getting_started/ros_installation.html">contents/getting_started/ros_installation</a>.</p>
