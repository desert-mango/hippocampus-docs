# Build And Flash


## Build The Firmware


We replaced the original FCU with the Pixhawk4, which is a 5th generation board. So the build command is:


```console
$ make px4_fmu-v5_default
```

If you get an error message that tells you, the `gcc-arm-none-eabi` could not be found, make sure you have installed it (for example via the `Tools/setup/ubuntu.sh` convenience script). In some cases, the path is not correctly extended, so it might be necessary to copy the line similar to


```console
$ export PATH=/opt/gcc-arm-none-eabi-9-2020-q2-update/bin:$PATH
```

from `~/.profile` to `~/.bashrc` (or in case you use `zsh` to `~/.zshrc`).


<div class="adm adm-attention"><p class="adm-title">Attention</p>

The version of `gcc-arm-none-eabi` might change, so it is necessary that you copy the line from your `~/.profile` and not the one in this docs.



</div>

## Flash The Firmware


You need to be able to reach the BlueROV's Raspberry Pi via ssh. The most convenient way is to create a `bash` script.


<div class="adm adm-attention"><p class="adm-title">Attention</p>

Please update the following code block in case the BlueROV's host or username changes.



</div>

```sh
#!/bin/bash
scp /PATH/TO/YOUR/PX4/FILE/px4_fmu-v5_default.px4 ubuntu@ubuntu.local:~/px4_fmu-v5_default.px4
ssh ubuntu@ubuntu.local << EOF
python3 ~/Firmware/Tools/px_uploader.py --port /dev/ttyACM0 ~/px4_fmu-v5_default.px4
EOF
```


<p class="provenance">Migrated from the previous docs site: <a href="https://hippocampusrobotics.github.io/docs/contents/bluerov/build_and_flash.html">contents/bluerov/build_and_flash</a>.</p>
