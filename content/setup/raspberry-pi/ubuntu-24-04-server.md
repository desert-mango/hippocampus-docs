# Ubuntu 24.04 Server 64bit



## Modify Cloud-Init


Modify `user-data` on the `system-boot` partition to your liking. An example configuration is provided below:


```yaml
#cloud-config

hostname: hippo-main-04
manage_etc_hosts: true
locale: en_US.UTF-8
timezone: Europe/Berlin

users:
    - name: pi
      groups: sudo, dialout, video
      sudo: "ALL=(ALL) NOPASSWD:ALL"
      # false -> allow password login
      lock_passwd: false
      shell: /bin/bash
      # plain_text_passwd: "<set-your-own-password>"
      ssh_authorized_keys:
      - <your-ssh-public-key>

# allow password ssh login
ssh_pwauth: true

package_update: true
package_upgrade: true
packages:
    - avahi-daemon

power_state: 
    mode: reboot
    delay: now
    condition: True
```

<div class="adm adm-note"><p class="adm-title">Note</p>

Make sure to connect the Raspberry Pi with the Internet via Ethernet before booting the first time.



</div>

## Boot Config

On the `system-boot` partition of the SD Card prepared for the Pi, edit `config.txt` and append the required lines for the specific setup.


<div class="adm adm-note"><p class="adm-title">Note</p>

This can also be done from the live system later on. The path to the file is then `/boot/firmware/config.txt`



</div>

See [the documentation](https://github.com/raspberrypi/firmware/blob/master/boot/overlays/README) for details on device tree overlays.


### I2C


```ini
dtparam=i2c_arm=on
dtoverlay=i2c6,pins_22_23
dtoverlay=i2c4,pins_6_7
```

The three lines create three buses on the GPIO header:

| Line | Device | Pins |
|---|---|---|
| `dtparam=i2c_arm=on` | `/dev/i2c-1` | GPIO2 (SDA) / GPIO3 (SCL) |
| `dtoverlay=i2c6,pins_22_23` | `/dev/i2c-6` | GPIO22 (SDA) / GPIO23 (SCL) |
| `dtoverlay=i2c4,pins_6_7` | `/dev/i2c-4` | GPIO6 (SDA) / GPIO7 (SCL), the ESC bus on the UUV (see [Pinout](#/setup/raspberry-pi/pinout)) |

`dtparam=i2c_arm=on` is a base device-tree parameter, so it must come before any `dtoverlay=` line. If `config.txt` already contains it, do not add it a second time. After a reboot, `ls /dev/i2c-*` should list `i2c-1`, `i2c-4` and `i2c-6` (plus the GPU-internal `i2c-20` and `i2c-21`).

### UART


```ini
dtoverlay=uart2
dtoverlay=uart3
dtoverlay=uart4
dtoverlay=uart5
```

## Disable Interactive Upgrade


Edit `needrestart.conf` so it contains the following entries (uncomment and modify as required)


```conf
$nrconf{restart} = 'a';
$nrconf{kernelhints} = 0
```

## Create Workspace


```console
$ mkdir -p ~/ros2/src \
&& mkdir -p ~/ros2_underlay/src
```

### Concept











<p class="provenance">Migrated from the previous docs site: <a href="https://hippocampusrobotics.github.io/docs/contents/raspberry_pi_setup/ubuntu_24.04_server_64bit.html">contents/raspberry_pi_setup/ubuntu_24.04_server_64bit</a>.</p>
