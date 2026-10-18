# ROS Workspace2


<div class="adm adm-attention"><p class="adm-title">Attention</p>

The following workspace structure is recommended in general, but is mandatory for shared devices (i.e. every device that is not your own computer, like Raspberry Pis or lab computers) to avoid confusion.



</div>

We use `ros2` as depicted in [ROS2 Workspace](#/setup/concepts/ros2-workspace) as  workspace and `ros2_underlay` shown in [ROS2 Workspace](#/setup/concepts/ros2-workspace) for larger manually compiled non-development packages that take a lot of time to compile/recompile.


```bash
~/ros2
├── build
│   └── ...
├── install
│   └── ...
├── log
│   └── ...
└── src
   ├── hippo_core                   # required for every ros2 workspace
   ├── hippo_simulation             # not needed for Raspberry Pi setups
   ├── qualisys_bridge              # only needed for the computer running the qualisys bridge
   ├── rapid_trajectories           # example for your custom development ros packages
   ├── rapid_trajectories_msgs      # exampale for your corresponding custom msg package
   └── ...
```

```bash
~/ros2_underlay
├── build
│   └── ...
├── install
│   └── ...
├── log
│   └── ...
└── src
   ├── apriltag_ros
   └── px4_msgs                     # Takes very long to build! Even if built already.
```

Having them in a separate workspace reduces compilation time for the development workspace. Typical packages for `ros2_underlay` are `plot_juggler`, `px4_msgs`, `apriltag_ros` and everything that is not going to be modified regularily.


<p class="provenance">Migrated from the previous docs site: <a href="https://hippocampusrobotics.github.io/docs/contents/concepts/ros2_workspace.html">contents/concepts/ros2_workspace</a>.</p>
