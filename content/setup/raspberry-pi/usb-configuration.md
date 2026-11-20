# USB Configuration


Similar to the UART configuration we can add a UDEV rule to identify the Pixracer if connected via USB and create a symlink with meaningful name.


Create the file `/etc/udev/rules.d/50-fcu.rules` and add the following lines:


<div class="tabs">

<div class="tab" data-label="PixRacer">

```sh
KERNEL=="ttyACM[0-9]*", GROUP="dialout", ENV{FCU_USB}="fcu_usb"

ENV{FCU_USB}=="fcu_usb", SUBSYSTEM=="tty", ATTRS{idVendor}=="26ac", ATTRS{idProduct}=="0012", SYMLINK+="fcu_usb"
```

</div>

<div class="tab" data-label="PixHawk 4">

```sh
KERNEL=="ttyACM[0-9]*", GROUP="dialout", ENV{FCU_USB}="fcu_usb"

ENV{FCU_USB}=="fcu_usb", SUBSYSTEM=="tty", ATTRS{idVendor}=="26ac", ATTRS{idProduct}=="0032", SYMLINK+="fcu_usb"
```

</div>

<div class="tab" data-label="PixHawk 6C">

```sh
SUBSYSTEM=="tty", ATTRS{idVendor}=="1d6b", ATTRS{idProduct}=="0002", SYMLINK+="fcu_usb", MODE="0666"
```

</div>


</div>

Retrigger the rules:


```console
$ sudo udevadm control --reload-rules && sudo udevadm trigger
```

To check, that the rule is applied correctly, you can execute


```console
$ ls /dev/fcu* -l
```

And the result should show at least the marked line:


```console
lrwxrwxrwx 1 root root 7 Jun 16 08:13 /dev/fcu_debug -> ttyAMA1
lrwxrwxrwx 1 root root 7 Jun 16 08:13 /dev/fcu_data -> ttyAMA2
lrwxrwxrwx 1 root root 7 Jun 16 08:13 /dev/fcu_usb -> ttyACM0
```


<p class="provenance">Migrated from the previous docs site: <a href="https://hippocampusrobotics.github.io/docs/contents/raspberry_pi_setup/usb_configuration.html">contents/raspberry_pi_setup/usb_configuration</a>.</p>
