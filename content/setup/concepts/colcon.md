# Colcon


Colcon is the build tool used to build our ROS workspace. We have convenience scripts to use colcon for our typical use cases to spare us some tedious typing.


## When and What to Source


For convenience, we automatically source our ROS workspace(s) for each terminal via the respective `source` commands inside the `.zshrc`. This way, we do not have to do this for every new terminal by hand, when we want to run any ROS related commands/nodes/launch setups.


But for building our workspace, we should **not** have sourced the workspace beforehand (see [this](https://github.com/colcon/colcon-core/issues/409)). Hence, we need to *unsource* the workspace before we build it.


## How to Build the Workspace when We Autosource the ROS Workspaces


As said before, we need to get rid of the workspaces that we source automatically when opening new shell sessions. This can be done via running commands with the prefix `env -i`. This clears the whole environment of our shell. Thus, sourcing the basic ROS installation and optionally any required underlay worskapce is needed afterwards. We want to execute colcon inside a shell, for example `bash` (the used shell does not matter here). To exectute commands directly, we run `bash -c '<INSERT_THE_COMMAND_HERE>'` The command in our case is to source the required environment and subsequently build the workspace via `colcon`.


```console
$ env -i HOME=$HOME bash -c 'source $HOME/ros2_underlay/install/setup.bash && colcon build'
```

But that is not all. For even more convenience, we usually want to add the `--symlink-install` argument. This way we do not need to rebuild the workspace when we change Python nodes, launch files, `yaml` files, etc. Changes in `cpp` files obviously still need a rebuilt. It is a compiled language in the end.


<div class="adm adm-note"><p class="adm-title">Note</p>

A rebuilt is still required if we add **new** files for the first time to create the link to the respective file.



</div>

Furthermore, we hand over `cmake` arguments to generate the `compile_commands.json` and surpress the related warnings. The `compile_commands.json` might be required for auto-completion features depending on the used editor/IDE.


```sh
--cmake-args --no-warn-unused-cli -DCMAKE_EXPORT_COMPILE_COMMANDS=ON
```

The whole command to build the workspace becomes



```console
$ env -i HOME=$HOME bash -c 'source $HOME/ros2_underlay/install/setup.bash && cd $HOME/ros2 && colcon build --symlink-install --cmake-args --no-warn-unused-cli -DCMAKE_EXPORT_COMPILE_COMMANDS=ON'
```

This is quite lengthy.


## A Quick Remedy for Very Long Commands


A quick way to reduce the complexity of the command we have to enter is to create an alias in our `.zsherc`


```zsh
alias build_ros="env -i HOME=$HOME bash -c 'source $HOME/ros2_underlay/install/setup.bash && cd $HOME/ros2 && colcon build --symlink-install --cmake-args --no-warn-unused-cli -DCMAKE_EXPORT_COMPILE_COMMANDS=ON'"
```

So we only need to remember the `build_ros` command to build our workspace.


The disadvantage of the alias is that it is not straightforward to hand over additional arguments to colcon. The most common arguments would be `--packages-select [package list]` and `--packages-up-to`. This way we can control which packages should be build. For a small workspace this does not matter too much. For larger workspaces rebuilding the whole workspace might take a considerable amount of time (even with no changes made to any file!). Especially if no changes were made and we would like the build command to finish immediately.


## A More Flexible Approach


To help with the most common cases of building a single package only, a single package with all its dependencies, or the whole workspace, we have added a `build-ros` script in `hippo_common`.


Sometimes, we want to delete certain packages in our workspace's `build/` and `install/` directory without writing


```console
$ rm -rf build/{package1,package2,package3} build/{package1,package2,package3}
```

Usually, we want to either delete only the package we are working on currently or its dependencies. Hence, the `clean-ros` scripts provides the ability to so.


<div class="adm adm-warning"><p class="adm-title">Warning</p>

Deleting files can be dangerous because it is quite irreversible by its nature. We do not take responsibility for any damage caused by accidentally deleted files by our software.



</div>

## Install the Convenience Scripts


Install the scripts via


```console
$ ~/ros2/src/hippo_core/hippo_common/scripts/install_scripts.sh
```

For a better auto completion we add the required `argcomplete` line to our `.zshrc` by executing


```console
$ echo "eval \"\$(register-python-argcomplete3 build-ros)\"" >> ~/.zshrc
$ echo "eval \"\$(register-python-argcomplete3 clean-ros)\"" >> ~/.zshrc
```


<p class="provenance">Migrated from the previous docs site: <a href="https://hippocampusrobotics.github.io/docs/contents/concepts/colcon.html">contents/concepts/colcon</a>.</p>
