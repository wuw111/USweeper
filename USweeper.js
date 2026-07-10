/*-----------------------------------------------------------------------
 USweeper 实体清理插件
 作者：wuw111

 【授权声明】
 本项目基于 AGPL-3.0 协议开源。详细条款、例外情况及授权定义，
 请参阅项目根目录下的 LICENSE 文件。

 温馨提示：本插件永久免费且开源。若您为下载此插件或解锁其
 任何功能而付费，即表明您可能已经受骗。
 请访问官方项目地址以获取最安全、免费的原始版本。
 官方地址：https://github.com/wuw111/USweeper
-----------------------------------------------------------------------*/

const PLUGIN_NAME = "USweeper";
const VERSION = [1, 1, 0]; 
const DIR_PATH = "plugins/" + PLUGIN_NAME;
const CONFIG_PATH = DIR_PATH + "/config.json";

logger.setTitle(PLUGIN_NAME);

if (!File.exists(DIR_PATH)) {
    File.mkdir(DIR_PATH);
}

const DEFAULT_CONFIG = {
    whitelist:[
        "minecraft:shulker_box",
        "minecraft:netherite",
        "minecraft:diamond",
        "minecraft:ender_dragon",
        "minecraft:ancient_debris",
        "minecraft:beacon",
        "minecraft:dragon_egg",
        "minecraft:nether_star",
        "minecraft:elytra",
        "minecraft:emerald",
        "minecraft:ender_crystal",
        "minecraft:ender_eye",
        "minecraft:ender_pearl",
        "minecraft:enchanted_book",
        "minecraft:painting",
        "minecraft:sea_lantern",
        "minecraft:totem_of_undying",
        "minecraft:villager",
        "minecraft:villager_v2",
        "minecraft:chicken",
        "minecraft:cow",
        "minecraft:sheep",
        "minecraft:rabbit",
        "minecraft:mooshroom",
        "minecraft:bee",
        "minecraft:pig",
        "minecraft:minecart",
        "minecraft:hopper_minecart",
        "minecraft:command_block_minecart",
        "minecraft:chest_minecart",
        "minecraft:iron_golem",
        "minecraft:snow_golem",
        "minecraft:copper_golem",
        "minecraft:boat",
        "minecraft:chest_boat",
        "minecraft:armor_stand",
        "minecraft:cat",
        "minecraft:wolf",
        "minecraft:shulker",
        "minecraft:wither_skeleton",
        "minecraft:wither",
        "minecraft:pillager",
        "minecraft:vindicator",
        "minecraft:witch",
        "minecraft:evoker",
        "minecraft:ravager",
        "minecraft:allay",
        "minecraft:leash_knot"
    ],
    limits: {
        enabled: true,
        checkInterval: 30,
        maxEntities: 200
    },
    timer: {
        enabled: true,
        interval: 600
    },
    tps: {
        enabled: true,
        checkInterval: 10,
        threshold: 15.0
    },
    vote: {
        enabled: true,
        duration: 30,
        immediateYesRatio: 0.7,
        timeoutMaxNoRatio: 0.3
    },
    admin: {
        enabled: true
    },
    cleanup: {
        delay: 15,
        warningMark: 5,
        safetyLockSeconds: 60,
        ignoreTamedAndTrusted: true
    }
};

let configObj = null;
if (File.exists(CONFIG_PATH)) {
    try {
        configObj = JSON.parse(File.readFrom(CONFIG_PATH));
    } catch (e) {
        logger.error("检测到 config.json 存在语法错误，已备份并重置为默认配置！");
        File.writeTo(DIR_PATH + "/config_error_backup.json", File.readFrom(CONFIG_PATH) || "");
    }
}

let modified = false;
if (!configObj) {
    configObj = DEFAULT_CONFIG;
    modified = true;
} else {
    function mergeConf(target, source) {
        for (let k in source) {
            if (target[k] === undefined) {
                target[k] = source[k];
                modified = true;
            } else if (typeof source[k] === "object" && !Array.isArray(source[k]) && source[k] !== null) {
                if (typeof target[k] !== "object") {
                    target[k] = {};
                    modified = true;
                }
                mergeConf(target[k], source[k]);
            }
        }
    }
    mergeConf(configObj, DEFAULT_CONFIG);
}

if (modified) {
    File.writeTo(CONFIG_PATH, JSON.stringify(configObj, null, 4));
}

const config = configObj;
const whitelist = config.whitelist;

let pendingCleanup = null;
let activeVote = null;
let cleanupCooldownUntil = 0;
let getTpsApi = null;
let globalTasks =[];

/**
 * 核心验证：检测实体是否允许被清理
 */
function isCleanable(en) {
    if (!en || en.isPlayer()) return false;

    if (config.cleanup.ignoreTamedAndTrusted && en.isTrusting) {
        return false;
    }

    let typeStr = en.type || "";
    let nameStr = en.name || "";
    for (let w of whitelist) {
        if (typeStr.includes(w) || nameStr.includes(w)) return false;
    }

    let tags = en.getAllTags();
    if (tags && tags.length > 0) {
        for (let t of tags) {
            for (let w of whitelist) {
                if (t.includes(w)) return false;
            }
        }
    }

    if (en.isItemEntity()) {
        let item = en.toItem();
        if (item && !item.isNull()) {
            let iType = item.type || "";
            let iName = item.name || "";
            for (let w of whitelist) {
                if (iType.includes(w) || iName.includes(w)) return false;
            }
        }
    }

    let nbt = null;
    try {
        nbt = en.getNbt();
    } catch(e) {
        return true;
    }
    if (!nbt) return true;

    let customName = nbt.getData("CustomName");
    if (customName && customName !== "") {
        nbt.destroy();
        return false;
    }

    if (config.cleanup.ignoreTamedAndTrusted) {
        if (nbt.getData("IsTamed") === 1 || nbt.getData("IsTrusting") === 1) {
            nbt.destroy();
            return false;
        }
    }

    let mainhand = nbt.getData("Mainhand");
    if (mainhand && mainhand.getSize && mainhand.getSize() > 0) {
        let handItem = mainhand.getData(0);
        let hName = handItem ? handItem.getData("Name") : null;
        if (hName && hName !== "") {
            nbt.destroy();
            return false;
        }
    }

    let armor = nbt.getData("Armor");
    if (armor && armor.getSize && armor.getSize() > 0) {
        for (let i = 0; i < armor.getSize(); i++) {
            let aItem = armor.getData(i);
            let aName = aItem ? aItem.getData("Name") : null;
            if (aName && aName !== "") {
                nbt.destroy();
                return false;
            }
        }
    }

    nbt.destroy();
    return true;
}

/**
 * 触发清理总调度进程
 */
function triggerCleanup(reasonStr, precalculatedTargets = null, isManual = false) {
    if (pendingCleanup) return;
    if (!isManual && Date.now() < cleanupCooldownUntil) return;

    let targets = precalculatedTargets;
    
    if (!targets) {
        targets =[];
        let all = mc.getAllEntities();
        for (let en of all) {
            if (isCleanable(en)) {
                let eid = en.runtimeId != null ? en.runtimeId : en.uniqueId;
                if (eid != null) {
                    let numId = Number(eid);
                    if (!isNaN(numId)) {
                        targets.push(numId);
                    }
                }
            }
        }
    }

    if (targets.length === 0) return;

    let delay = config.cleanup.delay;
    mc.broadcast(`§b[USweeper] §e预计在 §c${delay} §e秒后清理 §a${targets.length} §e个实体，原因：§7${reasonStr}`);

    let countdown = delay;
    let taskId = setInterval(() => {
        countdown--;
        if (countdown === config.cleanup.warningMark) {
            mc.broadcast(`§b[USweeper] §c警告：实体清理将在 ${countdown} 秒后执行！`);
        } else if (countdown <= 0) {
            executeCleanup(targets);
        }
    }, 1000);

    pendingCleanup = { taskId: taskId, targets: targets };
}

/**
 * 最终行刑：只查杀在触发时刻被收录的实体ID，并在行刑前执行二次校验
 */
function executeCleanup(targets) {
    if (pendingCleanup && pendingCleanup.taskId) {
        clearInterval(pendingCleanup.taskId);
    }
    
    let successCount = 0;
    for (let id of targets) {
        if (id == null || isNaN(id)) continue;
        try {
            let en = mc.getEntity(id);
            if (en) {
                if (isCleanable(en)) {
                    en.despawn();
                    successCount++;
                }
            }
        } catch (e) {
        }
    }
    
    mc.broadcast(`§b[USweeper] §a清理完成！已成功清理 ${successCount} 个掉落物/实体。`);
    pendingCleanup = null;
    cleanupCooldownUntil = Date.now() + config.cleanup.safetyLockSeconds * 1000;
}

/**
 * 发起玩家投票主干逻辑
 */
function startVote(initiator) {
    if (activeVote || pendingCleanup) return;
    
    activeVote = {
        yes: [],
        no:[],
        endTime: Date.now() + config.vote.duration * 1000,
        taskId: null
    };
    
    activeVote.yes.push(initiator.xuid);
    mc.broadcast(`§b[USweeper] §e玩家 §a${initiator.realName} §e发起了实体清理投票！输入 §b/clean §e参与投票，时长 §c${config.vote.duration} §e秒。`);
    
    activeVote.taskId = setInterval(() => {
        if (!activeVote) return;
        
        let onlinePlayers = mc.getOnlinePlayers().filter(p => !p.isSimulatedPlayer());
        let total = onlinePlayers.length;
        if (total === 0) {
            endVote(false);
            return;
        }
        
        let yesCount = activeVote.yes.length;
        let noCount = activeVote.no.length;
        
        if (yesCount / total >= config.vote.immediateYesRatio) {
            mc.broadcast(`§b[USweeper] §a支持率达到 ${(config.vote.immediateYesRatio * 100).toFixed(0)}%，投票提前通过！`);
            endVote(true);
            return;
        }
        
        if (Date.now() >= activeVote.endTime) {
            if (noCount / total < config.vote.timeoutMaxNoRatio) {
                mc.broadcast(`§b[USweeper] §a投票结束，反对率低于 ${(config.vote.timeoutMaxNoRatio * 100).toFixed(0)}%，投票通过！`);
                endVote(true);
            } else {
                mc.broadcast(`§b[USweeper] §c投票结束，反对率达到或超过 ${(config.vote.timeoutMaxNoRatio * 100).toFixed(0)}%，投票未通过。`);
                endVote(false);
            }
        }
    }, 1000);
    globalTasks.push(activeVote.taskId);
}

function endVote(success) {
    if (!activeVote) return;
    clearInterval(activeVote.taskId);
    activeVote = null;
    if (success) {
        triggerCleanup("玩家投票通过", null, true);
    }
}

/**
 * 发送投票操作表单
 */
function sendVoteMenu(player) {
    if (activeVote) {
        let fm = mc.newSimpleForm()
            .setTitle("清理实体投票")
            .setContent(`当前有正在进行的清理投票，距离结束还有 ${Math.ceil((activeVote.endTime - Date.now())/1000)} 秒。`)
            .addButton("支持清理")
            .addButton("反对清理");
        player.sendForm(fm, (pl, id) => {
            if (id === null) return;
            if (id === 0) {
                if (!activeVote.yes.includes(pl.xuid)) activeVote.yes.push(pl.xuid);
                activeVote.no = activeVote.no.filter(x => x !== pl.xuid);
                pl.tell("§a您已投票：支持清理。");
            } else if (id === 1) {
                if (!activeVote.no.includes(pl.xuid)) activeVote.no.push(pl.xuid);
                activeVote.yes = activeVote.yes.filter(x => x !== pl.xuid);
                pl.tell("§c您已投票：反对清理。");
            }
        });
    } else {
        let fm = mc.newSimpleForm()
            .setTitle("发起清理投票")
            .setContent("当前无正在进行的投票。是否发起清理实体投票？")
            .addButton("发起投票")
            .addButton("取消");
        player.sendForm(fm, (pl, id) => {
            if (id === null) return;
            if (id === 0) {
                if (pendingCleanup) {
                    pl.tell("§c清理程序已在运行中！");
                    return;
                }
                startVote(pl);
            }
        });
    }
}

/**
 * 注册命令集
 */
function registerCommands() {
    if (config.vote.enabled) {
        let cmdClean = mc.newCommand("clean", "打开清理实体投票菜单", PermType.Any);
        cmdClean.overload([]);
        cmdClean.setCallback((cmd, origin) => {
            if (!origin.player || origin.player.isSimulatedPlayer()) return;
            sendVoteMenu(origin.player);
        });
        cmdClean.setup();
    }

    if (config.admin.enabled) {
        let cmdCleanAdmin = mc.newCommand("cleanadmin", "管理员强制触发实体清理", PermType.GameMasters);
        cmdCleanAdmin.overload([]);
        cmdCleanAdmin.setCallback((cmd, origin) => {
            let name = origin.player ? origin.player.realName : "控制台";
            mc.broadcast(`§b[USweeper] §c管理员 §a${name} §c强制发起了实体清理！`);
            if (activeVote) {
                clearInterval(activeVote.taskId);
                activeVote = null;
                mc.broadcast(`§b[USweeper] §e当前正在进行的投票已被管理员覆盖终止。`);
            }
            triggerCleanup("管理员强制执行", null, true);
        });
        cmdCleanAdmin.setup();
    }
}

/**
 * 装载自动执行与侦测主循环队列
 */
function startTasks() {
    if (config.limits.enabled) {
        globalTasks.push(setInterval(() => {
            if (pendingCleanup || Date.now() < cleanupCooldownUntil) return;
            
            let cleanableEntitiesIds = [];
            let all = mc.getAllEntities();
            for (let en of all) {
                if (isCleanable(en)) {
                    let eid = en.runtimeId != null ? en.runtimeId : en.uniqueId;
                    if (eid != null) {
                        let numId = Number(eid);
                        if (!isNaN(numId)) {
                            cleanableEntitiesIds.push(numId);
                        }
                    }
                }
            }

            if (cleanableEntitiesIds.length > config.limits.maxEntities) {
                triggerCleanup("实体数量超限", cleanableEntitiesIds, false);
            }
        }, config.limits.checkInterval * 1000));
    }

    if (config.timer.enabled) {
        globalTasks.push(setInterval(() => {
            if (pendingCleanup || Date.now() < cleanupCooldownUntil) return;
            triggerCleanup("定时清理", null, false);
        }, config.timer.interval * 1000));
    }

    if (config.tps.enabled && getTpsApi) {
        globalTasks.push(setInterval(() => {
            if (pendingCleanup || Date.now() < cleanupCooldownUntil) return;
            
            let currentTps = getTpsApi();
            if (currentTps != null && currentTps < config.tps.threshold) {
                triggerCleanup(`服务器性能过低 (TPS: ${currentTps.toFixed(2)})`, null, false);
            }
        }, config.tps.checkInterval * 1000));
    }
}

mc.listen("onServerStarted", () => {
    if (config.tps.enabled) {
        getTpsApi = ll.import("UEssential", "getTpsInstant");
        if (!getTpsApi) {
            logger.warn("未找到 UEssential 插件或其 'getTpsInstant' API，TPS清理功能将不会启动。");
        }
    }
    
    registerCommands();
    startTasks();
    logger.info(`${PLUGIN_NAME} v${VERSION.join(".")} 已成功加载。作者：wuw111，插件反馈QQ群：1097933637`);
});

ll.onUnload(() => {
    if (pendingCleanup && pendingCleanup.taskId) clearInterval(pendingCleanup.taskId);
    if (activeVote && activeVote.taskId) clearInterval(activeVote.taskId);
    globalTasks.forEach(id => clearInterval(id));
    logger.info(PLUGIN_NAME + " 已成功卸载。");
});